import { randomUUID } from "node:crypto";

import type {
  CommentaryArtifact,
  CommentaryInput,
  CommentaryPipeline,
} from "@matchsense/commentary";
import type {
  CanonicalMoment,
  FixtureSnapshot,
  FixtureStreamEvent,
  ListeningControllerState,
  ReplayCommand,
  SourceFact,
  TeamCode,
  TeamSummary,
} from "@matchsense/contracts";
import {
  createFixtureProjection,
  reduceSourceFact,
  toFixtureSnapshot,
} from "@matchsense/event-engine";
import {
  advanceReplay,
  createReplaySession,
  DEMO_FIXTURE_ID,
  type ReplaySession,
} from "@matchsense/replay";
import {
  adaptSyntheticEnvelope,
  type TxlineCanonicalEvent,
} from "@matchsense/txline-adapter";

import {
  createAudioHub,
  type AudioHub,
  type AudioWritable,
} from "./audio-hub.js";

export const DEFAULT_TEAMS: readonly TeamSummary[] = [
  {
    code: "ARG",
    colors: { primary: "#75AADB", secondary: "#F3EFE4" },
    name: "Argentina",
  },
  {
    code: "BRA",
    colors: { primary: "#177C46", secondary: "#EACB46" },
    name: "Brazil",
  },
  {
    code: "ENG",
    colors: { primary: "#F5F5F2", secondary: "#C8102E" },
    name: "England",
  },
  {
    code: "ESP",
    colors: { primary: "#B51F32", secondary: "#F4C84A" },
    name: "Spain",
  },
  {
    code: "FRA",
    colors: { primary: "#173A70", secondary: "#D34D58" },
    name: "France",
  },
  {
    code: "JPN",
    colors: { primary: "#F4F1E8", secondary: "#BC3347" },
    name: "Japan",
  },
];

export interface ListeningSessionView {
  awayTeam: TeamCode;
  id: string;
  fixtureId: string;
  homeTeam: TeamCode;
  perspectiveTeam: TeamCode;
  state: ListeningControllerState;
  createdAt: string;
  lastMomentIdentity: string | null;
  sourceLabel: FixtureSnapshot["sourceLabel"];
}

type FixtureSubscriber = (event: FixtureStreamEvent) => void;
type CanonicalEventSubscriber = (event: TxlineCanonicalEvent) => void;

export interface ProductFixture {
  awayTeam: TeamCode;
  fixtureId: string;
  homeTeam: TeamCode;
  kickoffAt: string;
  participant1IsHome?: boolean;
  provenance: "synthetic_txline_shaped" | "live_txline";
}

export type ProductSourceState =
  | "authenticating"
  | "connecting"
  | "error"
  | "forbidden"
  | "live"
  | "reconnecting"
  | "reconciling"
  | "scheduled"
  | "stopped";

export interface ProductSourceHealth {
  detail: string | null;
  mode: "demo" | "live";
  state: ProductSourceState;
  updatedAt: string;
}

export interface ProductRuntimeOptions {
  commentaryPipeline?: Pick<CommentaryPipeline, "generate">;
  silenceBytes: Buffer;
  cueBytes: Buffer;
  fixture?: ProductFixture;
  fixtures?: readonly ProductFixture[];
  teamCatalog?: readonly TeamSummary[];
  includeDemoFixture?: boolean;
  mode?: "demo" | "live";
  notifyMoment?: (
    moment: CanonicalMoment,
    snapshot: FixtureSnapshot,
  ) => Promise<void> | void;
  transcodeCommentary?: (wavBytes: Buffer) => Promise<Buffer>;
  writeIntervalMs: number;
  now?: () => string;
  id?: () => string;
}

export function isConfirmedGoalMoment(
  moment: CanonicalMoment,
): moment is CanonicalMoment & {
  eventTeam: TeamCode;
  kind: "goal";
  status: "confirmed";
} {
  return (
    moment.kind === "goal" &&
    moment.status === "confirmed" &&
    moment.eventTeam !== null
  );
}

function createSingleFixtureRuntime(
  options: ProductRuntimeOptions & {
    fixture: ProductFixture;
  },
) {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  const fixtureDefinition = options.fixture;
  const teamCatalog = options.teamCatalog ?? DEFAULT_TEAMS;
  let projection = createFixtureProjection({
    awayTeam: fixtureDefinition.awayTeam,
    fixtureId: fixtureDefinition.fixtureId,
    homeTeam: fixtureDefinition.homeTeam,
    kickoffAt: fixtureDefinition.kickoffAt,
    observedAt: now(),
    provenance: fixtureDefinition.provenance,
  });
  const replaySessions = new Map<string, ReplaySession>();
  const listeningSessions = new Map<string, ListeningSessionView>();
  const fixtureSubscribers = new Map<string, Set<FixtureSubscriber>>();
  const canonicalEventSubscribers = new Map<
    string,
    Set<CanonicalEventSubscriber>
  >();
  const appliedCanonicalEvents = new Set<string>();
  const eventLog = new Map<string, FixtureStreamEvent[]>();
  const scoringTeamByMoment = new Map<string, TeamCode>();
  const audioHub: AudioHub = createAudioHub(options);
  const commentaryPreparations = new Map<
    string,
    Promise<{ artifact: CommentaryArtifact; mp3Bytes: Buffer | null }>
  >();
  const commentaryMp3 = new Map<string, Buffer>();
  const pendingCommentary = new Set<Promise<void>>();
  let closed = false;
  audioHub.start();

  const snapshot = () => toFixtureSnapshot(projection);
  const publish = (event: FixtureStreamEvent) => {
    const entries = eventLog.get(event.snapshot.fixtureId) ?? [];
    entries.push(event);
    eventLog.set(event.snapshot.fixtureId, entries);
    for (const subscriber of fixtureSubscribers.get(event.snapshot.fixtureId) ??
      []) {
      subscriber(event);
    }
  };
  const notifyMoment = (moment: CanonicalMoment) => {
    if (!options.notifyMoment || !isConfirmedGoalMoment(moment)) return;
    void Promise.resolve(options.notifyMoment(moment, snapshot())).catch(
      () => undefined,
    );
  };

  const trackCommentary = (work: Promise<void>) => {
    pendingCommentary.add(work);
    void work.finally(() => pendingCommentary.delete(work));
  };

  const commentaryInput = (
    moment: CanonicalMoment,
    scoringTeam: TeamCode,
  ): CommentaryInput => {
    const homeTeam =
      teamCatalog.find((team) => team.code === projection.homeTeam) ??
      DEFAULT_TEAMS.find((team) => team.code === projection.homeTeam);
    const awayTeam =
      teamCatalog.find((team) => team.code === projection.awayTeam) ??
      DEFAULT_TEAMS.find((team) => team.code === projection.awayTeam);
    if (!homeTeam || !awayTeam) {
      throw new Error("Commentary fixture teams are unavailable");
    }
    return {
      event: {
        awayTeam: { id: awayTeam.code, name: awayTeam.name },
        eventTeamId: scoringTeam,
        fixtureId: moment.fixtureId,
        homeTeam: { id: homeTeam.code, name: homeTeam.name },
        kind: "goal",
        minute: moment.minute,
        momentId: moment.id,
        playerDisplayName: null,
        revision: moment.revision,
        score: moment.score,
        status: "confirmed",
      },
      fan: {
        eventMode:
          moment.provenance === "synthetic_txline_shaped" ? "replay" : "live",
        language: "en",
        locale: "en-IN",
        perspectiveTeamId: null,
        voice: { name: "Kore", revision: "gemini-kore-v1" },
      },
    };
  };

  const prepareCommentary = (
    moment: CanonicalMoment,
    scoringTeam: TeamCode,
  ) => {
    if (!options.commentaryPipeline || !isConfirmedGoalMoment(moment)) {
      return null;
    }
    const key = `${moment.identity}:en-IN:${moment.provenance}:gemini-kore-v1`;
    const existing = commentaryPreparations.get(key);
    if (existing) return existing;
    const work = options.commentaryPipeline
      .generate(commentaryInput(moment, scoringTeam))
      .then(async ({ artifact }) => {
        let mp3Bytes = commentaryMp3.get(artifact.cacheKey) ?? null;
        if (!mp3Bytes && options.transcodeCommentary) {
          try {
            mp3Bytes = await options.transcodeCommentary(artifact.audio.bytes);
            commentaryMp3.set(artifact.cacheKey, mp3Bytes);
          } catch {
            mp3Bytes = null;
          }
        }
        return { artifact, mp3Bytes };
      });
    commentaryPreparations.set(key, work);
    void work.catch(() => commentaryPreparations.delete(key));
    return work;
  };

  const queueCommentary = (
    moment: CanonicalMoment,
    scoringTeam: TeamCode,
    deliveryIdentity: string,
    targetSessionIds?: readonly string[],
  ) => {
    if (!isConfirmedGoalMoment(moment)) return;
    const task = (async () => {
      const prepared = await prepareCommentary(moment, scoringTeam);
      if (!prepared || closed) return;
      const sessionIds =
        targetSessionIds ??
        [...listeningSessions.values()]
          .filter((session) => session.fixtureId === moment.fixtureId)
          .map((session) => session.id);
      if (prepared.mp3Bytes) {
        audioHub.inject(
          `${deliveryIdentity}:commentary:${prepared.artifact.language}`,
          sessionIds,
          prepared.mp3Bytes,
        );
      }
      publish({
        commentary: {
          generatedAt: prepared.artifact.createdAt,
          language: "en",
          momentIdentity: moment.identity,
          provider:
            prepared.artifact.provenance.speechProvider === "gemini"
              ? "gemini"
              : "deterministic",
          text: prepared.artifact.transcript,
          usedFallback: Boolean(
            prepared.artifact.provenance.atmosphereFallbackReason ||
            prepared.artifact.provenance.speechFallbackReason,
          ),
        },
        event: "commentary.ready",
        id: `commentary:${prepared.artifact.commentaryId}`,
        snapshot: snapshot(),
      });
    })().catch(() => undefined);
    trackCommentary(task);
  };

  const prewarmReplayCommentary = () => {
    if (projection.provenance !== "synthetic_txline_shaped") return;
    const revision = Math.max(1, projection.revision + 1);
    const prewarmFamilyId = `${projection.fixtureId}:event:synthetic-goal-arg-fra-1`;
    const moment =
      projection.lastEvent ??
      ({
        eventTeam: projection.homeTeam,
        familyId: prewarmFamilyId,
        fixtureId: projection.fixtureId,
        id: prewarmFamilyId,
        identity: `${prewarmFamilyId}:${revision}`,
        kind: "goal",
        minute: "23'",
        occurredAt: projection.updatedAt,
        provenance: "synthetic_txline_shaped",
        revision,
        score: { away: 0, home: 1 },
        sourceEnvelopeId: "synthetic-goal-arg-fra-1",
        status: "confirmed",
      } satisfies CanonicalMoment);
    const task = (async () => {
      await prepareCommentary(
        moment,
        scoringTeamByMoment.get(moment.identity) ?? projection.homeTeam,
      );
    })().catch(() => undefined);
    trackCommentary(task);
  };

  const fixture = (fixtureId: string): FixtureSnapshot | null =>
    fixtureId === projection.fixtureId ? snapshot() : null;

  const createListeningSession = (
    fixtureId: string,
    perspectiveTeam: TeamCode,
  ) => {
    if (fixtureId !== projection.fixtureId) return null;
    const session: ListeningSessionView = {
      awayTeam: projection.awayTeam,
      createdAt: now(),
      fixtureId,
      homeTeam: projection.homeTeam,
      id: id(),
      lastMomentIdentity: null,
      perspectiveTeam,
      sourceLabel: projection.sourceLabel,
      state: "listening",
    };
    listeningSessions.set(session.id, session);
    prewarmReplayCommentary();
    return session;
  };

  const commandReplay = (sessionId: string, command: ReplayCommand) => {
    const replay = replaySessions.get(sessionId);
    if (!replay) return { kind: "missing" as const };
    const requestedListeningSession = command.listeningSessionId
      ? listeningSessions.get(command.listeningSessionId)
      : null;
    if (
      command.listeningSessionId &&
      (!requestedListeningSession ||
        requestedListeningSession.fixtureId !== replay.fixtureId)
    ) {
      return { kind: "invalid_listening_session" as const };
    }
    const previousScore = projection.score;
    const envelope = advanceReplay(replay, command, now());
    if (!envelope) return { kind: "duplicate" as const };
    const fact = adaptSyntheticEnvelope(envelope);
    const wasAlreadyCanonical = projection.appliedSourceEnvelopeIds.includes(
      fact.sourceEnvelopeId,
    );
    const reduced = reduceSourceFact(projection, fact);
    projection = reduced.projection;
    if (!reduced.moment) {
      const canonicalMoment = projection.lastEvent;
      if (
        wasAlreadyCanonical &&
        canonicalMoment?.sourceEnvelopeId === fact.sourceEnvelopeId
      ) {
        if (requestedListeningSession) {
          requestedListeningSession.lastMomentIdentity =
            canonicalMoment.identity;
          if (isConfirmedGoalMoment(canonicalMoment)) {
            audioHub.inject(`replay:${replay.id}:${canonicalMoment.identity}`, [
              requestedListeningSession.id,
            ]);
          }
        }
        const scoringTeam =
          scoringTeamByMoment.get(canonicalMoment.identity) ??
          projection.homeTeam;
        queueCommentary(
          canonicalMoment,
          scoringTeam,
          `replay:${replay.id}:${canonicalMoment.identity}`,
          requestedListeningSession
            ? [requestedListeningSession.id]
            : undefined,
        );
        return {
          kind: "replayed" as const,
          moment: canonicalMoment,
          snapshot: snapshot(),
        };
      }
      return { kind: "accepted" as const, moment: null, snapshot: snapshot() };
    }
    const streamEvent: FixtureStreamEvent = {
      event: "moment.created",
      id: reduced.moment.identity,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
    const scoringTeam =
      reduced.moment.score.home > previousScore.home
        ? projection.homeTeam
        : projection.awayTeam;
    scoringTeamByMoment.set(reduced.moment.identity, scoringTeam);
    publish(streamEvent);
    notifyMoment(reduced.moment);
    const matchingListeners: string[] = [];
    for (const session of listeningSessions.values()) {
      if (session.fixtureId === projection.fixtureId) {
        session.lastMomentIdentity = reduced.moment.identity;
        matchingListeners.push(session.id);
      }
    }
    if (isConfirmedGoalMoment(reduced.moment)) {
      audioHub.inject(reduced.moment.identity, matchingListeners);
    }
    if (
      matchingListeners.length > 0 ||
      (fixtureSubscribers.get(reduced.moment.fixtureId)?.size ?? 0) > 0
    ) {
      queueCommentary(reduced.moment, scoringTeam, reduced.moment.identity);
    }
    return {
      kind: "accepted" as const,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
  };

  const acceptTxlineEvent = (event: TxlineCanonicalEvent) => {
    if (
      fixtureDefinition.provenance !== "live_txline" ||
      event.provenance !== "live_txline" ||
      event.fixtureId !== projection.fixtureId
    ) {
      return { kind: "ignored" as const };
    }
    const canonicalIdentity = [
      event.fixtureId,
      event.revision,
      event.source.payloadHash,
    ].join(":");
    if (appliedCanonicalEvents.has(canonicalIdentity)) {
      return { kind: "duplicate" as const };
    }
    appliedCanonicalEvents.add(canonicalIdentity);
    for (const subscriber of canonicalEventSubscribers.get(event.fixtureId) ??
      []) {
      subscriber(event);
    }
    if (
      event.action !== "goal" ||
      event.confirmed !== true ||
      event.score === null
    ) {
      return {
        kind: "accepted" as const,
        moment: null,
        snapshot: snapshot(),
      };
    }
    const previousScore = projection.score;
    const participant1IsHome = fixtureDefinition.participant1IsHome ?? true;
    const scoringTeam =
      event.participant === 1
        ? participant1IsHome
          ? projection.homeTeam
          : projection.awayTeam
        : event.participant === 2
          ? participant1IsHome
            ? projection.awayTeam
            : projection.homeTeam
          : event.score.home > previousScore.home
            ? projection.homeTeam
            : projection.awayTeam;
    const sourceEnvelopeId = [
      "txline",
      event.fixtureId,
      event.source.observedSeq ?? event.revision,
      event.source.payloadHash,
    ].join(":");
    const sourceActionId = event.actionId ?? event.source.actionId;
    const familyId = sourceActionId
      ? `txline:${event.fixtureId}:action:${sourceActionId}`
      : `txline:${event.fixtureId}:source:${event.source.observedSeq ?? event.source.payloadHash}`;
    const currentScores = projection.scores ?? {
      extraTime: { away: 0, home: 0 },
      regulation: projection.score,
      shootout: { away: 0, home: 0 },
    };
    const isExtraTime =
      projection.phase === "extra_time_first_half" ||
      projection.phase === "extra_time_half" ||
      projection.phase === "extra_time_second_half";
    const fact: SourceFact = {
      familyId,
      fixtureId: event.fixtureId,
      kind: "goal",
      // TxLINE's observed Clock.Seconds direction is not stable enough to
      // derive a display minute. Keep the verified score and show no minute.
      minute: "—",
      occurredAt:
        event.source.sourceTimestampMs === null
          ? null
          : new Date(event.source.sourceTimestampMs).toISOString(),
      player:
        event.playerId === null
          ? null
          : { displayName: null, id: event.playerId },
      provenance: "live_txline",
      receivedAt: event.receivedAt,
      scores: isExtraTime
        ? {
            ...currentScores,
            extraTime: {
              away: Math.max(
                0,
                event.score.away - currentScores.regulation.away,
              ),
              home: Math.max(
                0,
                event.score.home - currentScores.regulation.home,
              ),
            },
          }
        : { ...currentScores, regulation: event.score },
      sourceEnvelopeId,
      sourceEventId: sourceActionId ?? sourceEnvelopeId,
      status: "confirmed",
      team: scoringTeam,
      type: "canonical_event",
    };
    const reduced = reduceSourceFact(projection, fact);
    projection = reduced.projection;
    if (!reduced.changed) return { kind: "duplicate" as const };
    if (!reduced.moment) {
      return { kind: "accepted" as const, moment: null, snapshot: snapshot() };
    }
    scoringTeamByMoment.set(reduced.moment.identity, scoringTeam);
    const streamEvent: FixtureStreamEvent = {
      event: "moment.created",
      id: reduced.moment.identity,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
    publish(streamEvent);
    notifyMoment(reduced.moment);
    const matchingListeners = [...listeningSessions.values()]
      .filter((session) => session.fixtureId === event.fixtureId)
      .map((session) => {
        session.lastMomentIdentity = reduced.moment!.identity;
        return session.id;
      });
    if (isConfirmedGoalMoment(reduced.moment)) {
      audioHub.inject(reduced.moment.identity, matchingListeners);
    }
    if (
      matchingListeners.length > 0 ||
      (fixtureSubscribers.get(reduced.moment.fixtureId)?.size ?? 0) > 0
    ) {
      queueCommentary(reduced.moment, scoringTeam, reduced.moment.identity);
    }
    return {
      kind: "accepted" as const,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
  };

  return {
    acceptTxlineEvent,
    attachListeningClient: (sessionId: string, client: AudioWritable) =>
      listeningSessions.has(sessionId)
        ? audioHub.addClient(sessionId, client)
        : false,
    catalog: () => ({
      provenance: projection.provenance,
      sourceLabel: projection.sourceLabel,
      teams: teamCatalog,
    }),
    close: () => {
      closed = true;
      return audioHub.stop();
    },
    commandReplay,
    createListeningSession,
    createReplaySession: (fixtureId: string) => {
      const replay = createReplaySession(id(), fixtureId);
      replaySessions.set(replay.id, replay);
      return { fixtureId: replay.fixtureId, id: replay.id };
    },
    deleteListeningSession: (sessionId: string) => {
      audioHub.removeClient(sessionId);
      return listeningSessions.delete(sessionId);
    },
    fixture,
    fixtureEvents: (fixtureId: string) => [...(eventLog.get(fixtureId) ?? [])],
    fixtures: () => [snapshot()],
    listeningSession: (sessionId: string) =>
      listeningSessions.get(sessionId) ?? null,
    waitForCommentary: async () => {
      while (pendingCommentary.size > 0) {
        await Promise.all([...pendingCommentary]);
      }
    },
    subscribeFixture: (fixtureId: string, subscriber: FixtureSubscriber) => {
      if (fixtureId !== projection.fixtureId) return null;
      let subscribers = fixtureSubscribers.get(fixtureId);
      if (!subscribers) {
        subscribers = new Set();
        fixtureSubscribers.set(fixtureId, subscribers);
      }
      subscribers.add(subscriber);
      subscriber({
        event: "snapshot",
        id: `snapshot:${projection.revision}`,
        snapshot: snapshot(),
      });
      return () => subscribers?.delete(subscriber);
    },
    subscribeCanonicalEvent: (
      fixtureId: string,
      subscriber: CanonicalEventSubscriber,
    ) => {
      if (fixtureId !== projection.fixtureId) return null;
      let subscribers = canonicalEventSubscribers.get(fixtureId);
      if (!subscribers) {
        subscribers = new Set();
        canonicalEventSubscribers.set(fixtureId, subscribers);
      }
      subscribers.add(subscriber);
      return () => subscribers?.delete(subscriber);
    },
  };
}

type SingleFixtureRuntime = ReturnType<typeof createSingleFixtureRuntime>;

const DEMO_PRODUCT_FIXTURE: ProductFixture = {
  awayTeam: "FRA",
  fixtureId: DEMO_FIXTURE_ID,
  homeTeam: "ARG",
  kickoffAt: "2026-07-16T18:00:00.000Z",
  participant1IsHome: true,
  provenance: "synthetic_txline_shaped",
};

/**
 * Hosts every scheduled fixture behind one stable product API. The explicit
 * demo fixture can coexist as a hidden deep-link target without appearing in
 * the live schedule returned by `fixtures()`.
 */
export function createProductRuntime(options: ProductRuntimeOptions) {
  const explicitFixtures = options.fixtures;
  const publicFixtures = explicitFixtures
    ? [...explicitFixtures]
    : [options.fixture ?? DEMO_PRODUCT_FIXTURE];
  const allFixtures = [...publicFixtures];
  if (
    explicitFixtures &&
    options.includeDemoFixture &&
    !allFixtures.some(({ fixtureId }) => fixtureId === DEMO_FIXTURE_ID)
  ) {
    allFixtures.push(DEMO_PRODUCT_FIXTURE);
  }

  const runtimes = new Map<string, SingleFixtureRuntime>();
  for (const fixture of allFixtures) {
    runtimes.set(
      fixture.fixtureId,
      createSingleFixtureRuntime({ ...options, fixture }),
    );
  }
  const publicFixtureIds = new Set(
    publicFixtures.map(({ fixtureId }) => fixtureId),
  );
  const replayOwners = new Map<string, SingleFixtureRuntime>();
  const listeningOwners = new Map<string, SingleFixtureRuntime>();
  const mode =
    options.mode ??
    (publicFixtures.some(({ provenance }) => provenance === "live_txline")
      ? "live"
      : "demo");
  const now = options.now ?? (() => new Date().toISOString());
  const teamCatalog = options.teamCatalog ?? DEFAULT_TEAMS;
  let sourceHealth: ProductSourceHealth = {
    detail: null,
    mode,
    state: mode === "live" ? "scheduled" : "live",
    updatedAt: now(),
  };

  const runtimeForFixture = (fixtureId: string) =>
    runtimes.get(fixtureId) ?? null;

  return {
    acceptTxlineEvent: (event: TxlineCanonicalEvent) =>
      runtimeForFixture(event.fixtureId)?.acceptTxlineEvent(event) ?? {
        kind: "ignored" as const,
      },
    attachListeningClient: (sessionId: string, client: AudioWritable) =>
      listeningOwners
        .get(sessionId)
        ?.attachListeningClient(sessionId, client) ?? false,
    catalog: () => ({
      provenance:
        mode === "live"
          ? ("live_txline" as const)
          : ("synthetic_txline_shaped" as const),
      source: sourceHealth,
      sourceLabel:
        mode === "live"
          ? ("TXLINE · DEVNET SOURCE" as const)
          : ("SIMULATION · TXLINE-SHAPED DATA" as const),
      teams: teamCatalog,
    }),
    close: async () => {
      await Promise.all(
        [...runtimes.values()].map((runtime) => runtime.close()),
      );
    },
    commandReplay: (sessionId: string, command: ReplayCommand) =>
      replayOwners.get(sessionId)?.commandReplay(sessionId, command) ?? {
        kind: "missing" as const,
      },
    createListeningSession: (fixtureId: string, perspectiveTeam: TeamCode) => {
      const owner = runtimeForFixture(fixtureId);
      const session = owner?.createListeningSession(fixtureId, perspectiveTeam);
      if (owner && session) listeningOwners.set(session.id, owner);
      return session ?? null;
    },
    createReplaySession: (fixtureId: string) => {
      const owner = runtimeForFixture(fixtureId);
      if (!owner) throw new Error("Fixture not found");
      const session = owner.createReplaySession(fixtureId);
      replayOwners.set(session.id, owner);
      return session;
    },
    deleteListeningSession: (sessionId: string) => {
      const owner = listeningOwners.get(sessionId);
      if (!owner) return false;
      listeningOwners.delete(sessionId);
      return owner.deleteListeningSession(sessionId);
    },
    fixture: (fixtureId: string) =>
      runtimeForFixture(fixtureId)?.fixture(fixtureId) ?? null,
    fixtureEvents: (fixtureId: string) =>
      runtimeForFixture(fixtureId)?.fixtureEvents(fixtureId) ?? [],
    fixtures: () =>
      [...publicFixtureIds]
        .map((fixtureId) => runtimeForFixture(fixtureId)?.fixture(fixtureId))
        .filter(
          (fixture): fixture is FixtureSnapshot =>
            fixture !== null && fixture !== undefined,
        )
        .sort((left, right) => left.kickoffAt.localeCompare(right.kickoffAt)),
    listeningSession: (sessionId: string) =>
      listeningOwners.get(sessionId)?.listeningSession(sessionId) ?? null,
    setSourceHealth: (
      state: ProductSourceState,
      detail: string | null = null,
    ) => {
      sourceHealth = { detail, mode, state, updatedAt: now() };
    },
    subscribeCanonicalEvent: (
      fixtureId: string,
      subscriber: CanonicalEventSubscriber,
    ) =>
      runtimeForFixture(fixtureId)?.subscribeCanonicalEvent(
        fixtureId,
        subscriber,
      ) ?? null,
    subscribeFixture: (fixtureId: string, subscriber: FixtureSubscriber) =>
      runtimeForFixture(fixtureId)?.subscribeFixture(fixtureId, subscriber) ??
      null,
    waitForCommentary: async () => {
      await Promise.all(
        [...runtimes.values()].map((runtime) => runtime.waitForCommentary()),
      );
    },
  };
}

export type ProductRuntime = ReturnType<typeof createProductRuntime>;
