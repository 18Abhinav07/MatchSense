import { randomUUID } from "node:crypto";

import type { CommentaryInput, CommentaryPipeline } from "@matchsense/commentary";
import type {
  CanonicalMoment,
  FixtureProjection,
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
import type { ExperienceAudioPack } from "./experience-audio-pack.js";

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
  commentaryPipeline?: Pick<CommentaryPipeline, "generate"> &
    Partial<Pick<CommentaryPipeline, "synthesize">>;
  createMediaChunks?: (bytes: Buffer) => readonly Buffer[];
  silenceBytes: Buffer;
  cueBytes: Buffer;
  experienceAudioPack?: ExperienceAudioPack;
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

interface PreparedCommentary {
  readonly commentaryId: string;
  readonly generatedAt: string;
  readonly language: "en";
  readonly mp3Bytes: Buffer | null;
  readonly provider: "authored" | "gemini" | "deterministic";
  readonly text: string;
  readonly usedFallback: boolean;
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

/** Every canonical match beat that is useful in a continuous radio feed. */
export function isNarratableMoment(moment: CanonicalMoment) {
  return moment.kind !== "correction" || moment.status === "corrected";
}

function createSingleFixtureRuntime(
  options: ProductRuntimeOptions & {
    fixture: ProductFixture;
    initialEvents?: readonly FixtureStreamEvent[];
    initialProjection?: FixtureProjection;
  },
) {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  const fixtureDefinition = options.fixture;
  const teamCatalog = options.teamCatalog ?? DEFAULT_TEAMS;
  let projection = options.initialProjection
    ? structuredClone(options.initialProjection)
    : createFixtureProjection({
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
  if (options.initialEvents?.length) {
    eventLog.set(
      fixtureDefinition.fixtureId,
      options.initialEvents.map((event) => structuredClone(event)),
    );
  }
  const audioHub: AudioHub = createAudioHub(options);
  const commentaryPreparations = new Map<
    string,
    Promise<PreparedCommentary>
  >();
  const commentaryMp3 = new Map<string, Buffer>();
  const commentaryAudioByMomentIdentity = new Map<
    string,
    { bytes: Buffer; provider: "authored" | "gemini" | "deterministic" }
  >();
  let memoryIntroPreparation: Promise<Buffer | null> | null = null;
  const pendingCommentary = new Set<Promise<void>>();
  let commentaryGenerationTail: Promise<void> = Promise.resolve();
  let commentaryDeliveryTail: Promise<void> = Promise.resolve();
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
  const celebratesGoal = (moment: CanonicalMoment) => {
    return moment.celebratesGoal;
  };
  const notifyMoment = (moment: CanonicalMoment) => {
    if (!options.notifyMoment || !celebratesGoal(moment)) return;
    void Promise.resolve(options.notifyMoment(moment, snapshot())).catch(
      () => undefined,
    );
  };

  const trackCommentary = (work: Promise<void>) => {
    pendingCommentary.add(work);
    void work.finally(() => pendingCommentary.delete(work));
  };

  const commentaryInput = (moment: CanonicalMoment): CommentaryInput => {
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
        eventTeamId: moment.eventTeam,
        fixtureId: moment.fixtureId,
        homeTeam: { id: homeTeam.code, name: homeTeam.name },
        kind: moment.kind,
        minute: moment.minute,
        momentId: moment.id,
        playerDisplayName: moment.player?.displayName ?? null,
        revision: moment.revision,
        score: moment.score,
        status: moment.status,
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

  const commentaryPreparationKey = (moment: CanonicalMoment) =>
    `${moment.identity}:en-IN:${moment.provenance}:${
      fixtureDefinition.fixtureId.startsWith("experience:") &&
      fixtureDefinition.provenance === "synthetic_txline_shaped" &&
      moment.provenance === "synthetic_txline_shaped" &&
      options.experienceAudioPack
        ? "authored-v3"
        : "gemini-kore-v1"
    }`;

  const isFixedAuthoredExperienceMoment = (moment: CanonicalMoment) =>
    fixtureDefinition.fixtureId.startsWith("experience:") &&
    fixtureDefinition.provenance === "synthetic_txline_shaped" &&
    projection.provenance === "synthetic_txline_shaped" &&
    moment.provenance === "synthetic_txline_shaped" &&
    options.experienceAudioPack !== undefined;

  const authoredAssetForMoment = (moment: CanonicalMoment) =>
    isFixedAuthoredExperienceMoment(moment)
      ? (options.experienceAudioPack?.forMoment(moment) ?? null)
      : null;

  const prepareCommentary = (moment: CanonicalMoment) => {
    if (!isNarratableMoment(moment)) {
      return null;
    }
    const key = commentaryPreparationKey(moment);
    const existing = commentaryPreparations.get(key);
    if (existing) return existing;

    const authoredAsset = authoredAssetForMoment(moment);
    if (authoredAsset) {
      const bytes = Buffer.from(authoredAsset.bytes);
      commentaryAudioByMomentIdentity.set(moment.identity, {
        bytes: Buffer.from(bytes),
        provider: "authored",
      });
      const prepared = Promise.resolve({
        commentaryId: `${moment.identity}:authored-v3`,
        generatedAt: now(),
        language: "en" as const,
        mp3Bytes: bytes,
        provider: "authored" as const,
        text: authoredAsset.transcript,
        usedFallback: false,
      });
      commentaryPreparations.set(key, prepared);
      return prepared;
    }

    if (isFixedAuthoredExperienceMoment(moment)) return null;

    if (!options.commentaryPipeline) return null;
    const generate = () =>
      options.commentaryPipeline!.generate(commentaryInput(moment));
    const generated = commentaryGenerationTail.then(generate, generate);
    commentaryGenerationTail = generated.then(
      () => undefined,
      () => undefined,
    );
    const work = generated.then(async ({ artifact }) => {
      const realSpeech = artifact.provenance.speechProvider === "gemini";
      let mp3Bytes = commentaryMp3.get(artifact.cacheKey) ?? null;
      if (!mp3Bytes && options.transcodeCommentary) {
        try {
          mp3Bytes = await options.transcodeCommentary(artifact.audio.bytes);
          if (realSpeech) commentaryMp3.set(artifact.cacheKey, mp3Bytes);
        } catch {
          mp3Bytes = null;
        }
      }
      if (mp3Bytes) {
        commentaryAudioByMomentIdentity.set(moment.identity, {
          bytes: mp3Bytes,
          provider: realSpeech ? "gemini" : "deterministic",
        });
      }
      if (!realSpeech) commentaryPreparations.delete(key);
      return {
        commentaryId: artifact.commentaryId,
        generatedAt: artifact.createdAt,
        language: "en" as const,
        mp3Bytes,
        provider: realSpeech ? ("gemini" as const) : ("deterministic" as const),
        text: artifact.transcript,
        usedFallback: Boolean(
          artifact.provenance.atmosphereFallbackReason ||
            artifact.provenance.speechFallbackReason,
        ),
      };
    });
    commentaryPreparations.set(key, work);
    void work.catch(() => commentaryPreparations.delete(key));
    return work;
  };

  const queueCommentary = (
    moment: CanonicalMoment,
    deliveryIdentity: string,
    targetSessionIds?: readonly string[],
  ) => {
    if (!isNarratableMoment(moment)) return;
    // Start synthesis immediately, but serialize delivery so a faster later
    // request can never speak over or before an earlier canonical Moment.
    const preparation = prepareCommentary(moment);
    if (!preparation) return;
    const deliver = async () => {
      const prepared = await preparation;
      if (!prepared || closed) return;
      const sessionIds =
        targetSessionIds ??
        [...listeningSessions.values()]
          .filter((session) => session.fixtureId === moment.fixtureId)
          .map((session) => session.id);
      if (prepared.mp3Bytes) {
        audioHub.inject(
          `${deliveryIdentity}:commentary:${prepared.language}`,
          sessionIds,
          prepared.mp3Bytes,
        );
      }
      publish({
        commentary: {
          generatedAt: prepared.generatedAt,
          language: "en",
          momentIdentity: moment.identity,
          provider: prepared.provider,
          text: prepared.text,
          usedFallback: prepared.usedFallback,
        },
        event: "commentary.ready",
        id: `commentary:${prepared.commentaryId}`,
        snapshot: snapshot(),
      });
    };
    const task = commentaryDeliveryTail
      .then(deliver, deliver)
      .catch(() => undefined);
    commentaryDeliveryTail = task;
    trackCommentary(task);
  };

  const prewarmReplayCommentary = () => {
    if (projection.provenance !== "synthetic_txline_shaped") return;
    if (options.experienceAudioPack) return;
    const revision = Math.max(1, projection.revision + 1);
    const prewarmFamilyId = `${projection.fixtureId}:event:synthetic-goal-arg-fra-1`;
    const moment =
      projection.lastEvent ??
      ({
        celebratesGoal: true,
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
      await prepareCommentary(moment);
    })().catch(() => undefined);
    trackCommentary(task);
  };

  const prepareMemoryIntro = () => {
    if (
      projection.provenance === "synthetic_txline_shaped" &&
      options.experienceAudioPack
    ) {
      return Promise.resolve(
        Buffer.from(options.experienceAudioPack.memoryIntro.bytes),
      );
    }
    if (memoryIntroPreparation) return memoryIntroPreparation;
    if (
      !options.commentaryPipeline?.synthesize ||
      !options.transcodeCommentary
    ) {
      return Promise.resolve(null);
    }
    const preparation = options.commentaryPipeline
      .synthesize("Here is your MatchSense match summary.", "Kore")
      .then(async (speech) => {
        if (speech.provider !== "gemini") return null;
        return options.transcodeCommentary!(speech.bytes);
      })
      .catch(() => null);
    memoryIntroPreparation = preparation;
    void preparation.then((bytes) => {
      if (!bytes && memoryIntroPreparation === preparation) {
        memoryIntroPreparation = null;
      }
    });
    return preparation;
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
    void prepareMemoryIntro();
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
          if (celebratesGoal(canonicalMoment)) {
            audioHub.inject(`replay:${replay.id}:${canonicalMoment.identity}`, [
              requestedListeningSession.id,
            ]);
          }
        }
        queueCommentary(
          canonicalMoment,
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
    publish(streamEvent);
    notifyMoment(reduced.moment);
    const matchingListeners: string[] = [];
    for (const session of listeningSessions.values()) {
      if (session.fixtureId === projection.fixtureId) {
        session.lastMomentIdentity = reduced.moment.identity;
        matchingListeners.push(session.id);
      }
    }
    if (celebratesGoal(reduced.moment)) {
      audioHub.inject(reduced.moment.identity, matchingListeners);
    }
    if (
      matchingListeners.length > 0 ||
      (fixtureSubscribers.get(reduced.moment.fixtureId)?.size ?? 0) > 0
    ) {
      queueCommentary(reduced.moment, reduced.moment.identity);
    }
    return {
      kind: "accepted" as const,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
  };

  const acceptSourceFact = (fact: SourceFact) => {
    if (fact.fixtureId !== projection.fixtureId) {
      return { kind: "ignored" as const };
    }
    const familyId =
      fact.type === "canonical_event"
        ? (fact.targetFamilyId ?? fact.familyId)
        : `${fact.fixtureId}:event:${fact.sourceEnvelopeId}`;
    const wasExistingFamily = projection.eventEffects[familyId] !== undefined;
    const reduced = reduceSourceFact(projection, fact);
    projection = reduced.projection;
    if (!reduced.changed) return { kind: "duplicate" as const };
    if (!reduced.moment) {
      return { kind: "accepted" as const, moment: null, snapshot: snapshot() };
    }

    publish({
      event: wasExistingFamily ? "moment.revised" : "moment.created",
      id: `${projection.fixtureId}:revision:${projection.revision}`,
      moment: reduced.moment,
      snapshot: snapshot(),
    });
    notifyMoment(reduced.moment);

    const matchingListeners = [...listeningSessions.values()]
      .filter((session) => session.fixtureId === projection.fixtureId)
      .map((session) => {
        session.lastMomentIdentity = reduced.moment!.identity;
        return session.id;
      });
    if (celebratesGoal(reduced.moment)) {
      audioHub.inject(reduced.moment.identity, matchingListeners);
    }
    if (
      matchingListeners.length > 0 ||
      (fixtureSubscribers.get(reduced.moment.fixtureId)?.size ?? 0) > 0
    ) {
      queueCommentary(reduced.moment, reduced.moment.identity);
    }
    return {
      kind: "accepted" as const,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
  };

  const resolveMoment = (identity: string) => {
    const moments = (eventLog.get(projection.fixtureId) ?? []).flatMap(
      (event) => (event.moment ? [event.moment] : []),
    );
    const requested =
      moments.find((moment) => moment.identity === identity) ?? null;
    const familyId = requested?.familyId ?? identity.replace(/:\d+$/u, "");
    const latest =
      moments
        .filter((moment) => moment.familyId === familyId)
        .sort((left, right) => right.revision - left.revision)[0] ?? null;
    return {
      latest,
      requested,
      snapshot: snapshot(),
      superseded:
        latest !== null &&
        (requested === null || requested.identity !== latest.identity),
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
    if (projection.phase === "scheduled" && event.action !== "game_finalised") {
      acceptSourceFact({
        familyId: `txline:${event.fixtureId}:phase:kickoff`,
        fixtureId: event.fixtureId,
        kind: "phase.kickoff",
        minute: "0'",
        occurredAt:
          event.source.sourceTimestampMs === null
            ? null
            : new Date(event.source.sourceTimestampMs).toISOString(),
        player: null,
        provenance: "live_txline",
        receivedAt: event.receivedAt,
        sourceEnvelopeId: `txline:${event.fixtureId}:implicit-kickoff`,
        sourceEventId: `txline:${event.fixtureId}:implicit-kickoff`,
        status: "confirmed",
        team: null,
        type: "canonical_event",
      });
    }
    if (event.action === "game_finalised") {
      const participant1IsHome = fixtureDefinition.participant1IsHome ?? true;
      const stats = event.participantStats
        ? participant1IsHome
          ? {
              away: {
                ...event.participantStats.participant2,
                penaltiesAwarded: 0,
                penaltiesMissed: 0,
                penaltiesScored: 0,
              },
              home: {
                ...event.participantStats.participant1,
                penaltiesAwarded: 0,
                penaltiesMissed: 0,
                penaltiesScored: 0,
              },
            }
          : {
              away: {
                ...event.participantStats.participant1,
                penaltiesAwarded: 0,
                penaltiesMissed: 0,
                penaltiesScored: 0,
              },
              home: {
                ...event.participantStats.participant2,
                penaltiesAwarded: 0,
                penaltiesMissed: 0,
                penaltiesScored: 0,
              },
            }
        : undefined;
      const score = event.score ?? projection.score;
      const sourceEventId =
        event.actionId ?? event.source.actionId ?? event.source.payloadHash;
      return acceptSourceFact({
        familyId: `txline:${event.fixtureId}:action:${sourceEventId}`,
        fixtureId: event.fixtureId,
        kind: "phase.full_time",
        minute: "FT",
        occurredAt:
          event.source.sourceTimestampMs === null
            ? null
            : new Date(event.source.sourceTimestampMs).toISOString(),
        player: null,
        provenance: "live_txline",
        receivedAt: event.receivedAt,
        scores: {
          extraTime: projection.scores?.extraTime ?? { away: 0, home: 0 },
          regulation: score,
          shootout: projection.scores?.shootout ?? { away: 0, home: 0 },
        },
        sourceEnvelopeId: [
          "txline",
          event.fixtureId,
          event.source.observedSeq ?? event.revision,
          event.source.payloadHash,
        ].join(":"),
        sourceEventId,
        status: "confirmed",
        ...(stats ? { stats } : {}),
        team: null,
        type: "canonical_event",
      });
    }
    if (event.action === "halftime_finalised") {
      const score = event.score ?? projection.score;
      const sourceEventId =
        event.actionId ?? event.source.actionId ?? event.source.payloadHash;
      return acceptSourceFact({
        familyId: `txline:${event.fixtureId}:action:${sourceEventId}`,
        fixtureId: event.fixtureId,
        kind: "phase.half_time",
        minute: "HT",
        occurredAt:
          event.source.sourceTimestampMs === null
            ? null
            : new Date(event.source.sourceTimestampMs).toISOString(),
        player: null,
        provenance: "live_txline",
        receivedAt: event.receivedAt,
        scores: {
          extraTime: projection.scores?.extraTime ?? { away: 0, home: 0 },
          regulation: score,
          shootout: projection.scores?.shootout ?? { away: 0, home: 0 },
        },
        sourceEnvelopeId: [
          "txline",
          event.fixtureId,
          event.source.observedSeq ?? event.revision,
          event.source.payloadHash,
        ].join(":"),
        sourceEventId,
        status: "confirmed",
        team: null,
        type: "canonical_event",
      });
    }
    if (event.action === "var") {
      const sourceEventId =
        event.actionId ?? event.source.actionId ?? event.source.payloadHash;
      return acceptSourceFact({
        familyId: `txline:${event.fixtureId}:action:${sourceEventId}`,
        fixtureId: event.fixtureId,
        kind: "var.started",
        minute: "—",
        occurredAt:
          event.source.sourceTimestampMs === null
            ? null
            : new Date(event.source.sourceTimestampMs).toISOString(),
        player: null,
        provenance: "live_txline",
        receivedAt: event.receivedAt,
        sourceEnvelopeId: [
          "txline",
          event.fixtureId,
          event.source.observedSeq ?? event.revision,
          event.source.payloadHash,
        ].join(":"),
        sourceEventId,
        status: "under_review",
        team: null,
        type: "canonical_event",
      });
    }
    if (event.action === "var_end" && event.varOutcome) {
      const score = event.score ?? projection.score;
      const sourceEventId =
        event.actionId ?? event.source.actionId ?? event.source.payloadHash;
      return acceptSourceFact({
        familyId: `txline:${event.fixtureId}:action:${sourceEventId}`,
        fixtureId: event.fixtureId,
        kind:
          event.varOutcome === "overturned" ? "var.overturned" : "var.stands",
        minute: "—",
        occurredAt:
          event.source.sourceTimestampMs === null
            ? null
            : new Date(event.source.sourceTimestampMs).toISOString(),
        player: null,
        provenance: "live_txline",
        receivedAt: event.receivedAt,
        scores: {
          extraTime: projection.scores?.extraTime ?? { away: 0, home: 0 },
          regulation: score,
          shootout: projection.scores?.shootout ?? { away: 0, home: 0 },
        },
        sourceEnvelopeId: [
          "txline",
          event.fixtureId,
          event.source.observedSeq ?? event.revision,
          event.source.payloadHash,
        ].join(":"),
        sourceEventId,
        status: "confirmed",
        team: null,
        type: "canonical_event",
      });
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
    const participantStats = event.participantStats;
    const teamStats = (
      value: NonNullable<typeof participantStats>["participant1"],
    ) => ({
      corners: value.corners,
      penaltiesAwarded: 0,
      penaltiesMissed: 0,
      penaltiesScored: 0,
      redCards: value.redCards,
      yellowCards: value.yellowCards,
    });
    const stats = participantStats
      ? participant1IsHome
        ? {
            away: teamStats(participantStats.participant2),
            home: teamStats(participantStats.participant1),
          }
        : {
            away: teamStats(participantStats.participant1),
            home: teamStats(participantStats.participant2),
          }
      : undefined;
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
      ...(stats ? { stats } : {}),
      team: scoringTeam,
      type: "canonical_event",
    };
    const reduced = reduceSourceFact(projection, fact);
    projection = reduced.projection;
    if (!reduced.changed) return { kind: "duplicate" as const };
    if (!reduced.moment) {
      return { kind: "accepted" as const, moment: null, snapshot: snapshot() };
    }
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
    if (celebratesGoal(reduced.moment)) {
      audioHub.inject(reduced.moment.identity, matchingListeners);
    }
    if (
      matchingListeners.length > 0 ||
      (fixtureSubscribers.get(reduced.moment.fixtureId)?.size ?? 0) > 0
    ) {
      queueCommentary(reduced.moment, reduced.moment.identity);
    }
    return {
      kind: "accepted" as const,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
  };

  return {
    acceptSourceFact,
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
    commentaryAudio: async (fixtureId: string, identity: string) => {
      if (fixtureId !== projection.fixtureId) return null;
      let audio = commentaryAudioByMomentIdentity.get(identity);
      if (audio && audio.provider !== "deterministic") {
        return Buffer.from(audio.bytes);
      }
      const moment = (eventLog.get(fixtureId) ?? [])
        .map((event) => event.moment)
        .find((candidate) => candidate?.identity === identity);
      const preparation = moment ? prepareCommentary(moment) : null;
      if (preparation) await preparation.catch(() => undefined);
      audio = commentaryAudioByMomentIdentity.get(identity);
      return audio && audio.provider !== "deterministic"
        ? Buffer.from(audio.bytes)
        : null;
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
    memoryIntroAudio: (fixtureId: string) =>
      fixtureId === projection.fixtureId
        ? prepareMemoryIntro().then((bytes) =>
            bytes ? Buffer.from(bytes) : null,
          )
        : Promise.resolve(null),
    publishPersistedEvent: (
      event: FixtureStreamEvent,
      _delivery: { celebratesGoal?: boolean } = {},
    ) => {
      if (event.snapshot.fixtureId !== projection.fixtureId) return false;
      const existing = eventLog.get(projection.fixtureId) ?? [];
      if (existing.some((entry) => entry.id === event.id)) return false;
      if (event.snapshot.revision < projection.revision) return false;
      projection = {
        ...projection,
        ...structuredClone(event.snapshot),
        appliedSourceEnvelopeIds: projection.appliedSourceEnvelopeIds,
        eventEffects: projection.eventEffects,
      };
      publish(structuredClone(event));
      const moment = event.moment;
      if (moment) {
        const matchingListeners = [...listeningSessions.values()]
          .filter((session) => session.fixtureId === projection.fixtureId)
          .map((session) => {
            session.lastMomentIdentity = moment.identity;
            return session.id;
          });
        if (moment.celebratesGoal) {
          audioHub.inject(moment.identity, matchingListeners);
        }
        if (
          matchingListeners.length > 0 ||
          (fixtureSubscribers.get(moment.fixtureId)?.size ?? 0) > 0
        ) {
          queueCommentary(moment, moment.identity);
        }
      }
      return true;
    },
    restore: (
      nextProjection: FixtureProjection,
      events: readonly FixtureStreamEvent[],
    ) => {
      if (nextProjection.fixtureId !== projection.fixtureId) {
        throw new Error("Restored fixture projection does not match runtime");
      }
      projection = structuredClone(nextProjection);
      eventLog.set(
        projection.fixtureId,
        events.map((event) => structuredClone(event)),
      );
    },
    resolveMoment,
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
  const fixtureRegistrationSubscribers = new Set<(fixtureId: string) => void>();
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
    acceptSourceFact: (fact: SourceFact) =>
      runtimeForFixture(fact.fixtureId)?.acceptSourceFact(fact) ?? {
        kind: "ignored" as const,
      },
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
    commentaryAudio: (fixtureId: string, identity: string) =>
      runtimeForFixture(fixtureId)?.commentaryAudio(fixtureId, identity) ??
      Promise.resolve(null),
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
    memoryIntroAudio: (fixtureId: string) =>
      runtimeForFixture(fixtureId)?.memoryIntroAudio(fixtureId) ??
      Promise.resolve(null),
    onFixtureRegistered: (subscriber: (fixtureId: string) => void) => {
      fixtureRegistrationSubscribers.add(subscriber);
      return () => fixtureRegistrationSubscribers.delete(subscriber);
    },
    registerFixture: (
      fixture: ProductFixture,
      registration: {
        events?: readonly FixtureStreamEvent[];
        projection?: FixtureProjection;
        public?: boolean;
      } = {},
    ) => {
      let runtime = runtimeForFixture(fixture.fixtureId);
      const isNew = runtime === null;
      if (!runtime) {
        runtime = createSingleFixtureRuntime({
          ...options,
          fixture,
          ...(registration.events
            ? { initialEvents: registration.events }
            : {}),
          ...(registration.projection
            ? { initialProjection: registration.projection }
            : {}),
        });
        runtimes.set(fixture.fixtureId, runtime);
      } else if (registration.projection) {
        runtime.restore(registration.projection, registration.events ?? []);
      } else {
        const current = runtime.fixture(fixture.fixtureId);
        if (
          current?.phase === "scheduled" &&
          current.revision === 0 &&
          (current.awayTeam !== fixture.awayTeam ||
            current.homeTeam !== fixture.homeTeam ||
            current.kickoffAt !== fixture.kickoffAt)
        ) {
          runtime.restore(
            createFixtureProjection({
              awayTeam: fixture.awayTeam,
              fixtureId: fixture.fixtureId,
              homeTeam: fixture.homeTeam,
              kickoffAt: fixture.kickoffAt,
              observedAt: now(),
              provenance: fixture.provenance,
            }),
            [],
          );
        }
      }
      if (registration.public) publicFixtureIds.add(fixture.fixtureId);
      if (isNew) {
        for (const subscriber of fixtureRegistrationSubscribers) {
          subscriber(fixture.fixtureId);
        }
      }
      return runtime.fixture(fixture.fixtureId)!;
    },
    publishPersistedEvent: (
      event: FixtureStreamEvent,
      delivery?: { celebratesGoal?: boolean },
    ) =>
      runtimeForFixture(event.snapshot.fixtureId)?.publishPersistedEvent(
        event,
        delivery,
      ) ?? false,
    resolveMoment: (fixtureId: string, identity: string) =>
      runtimeForFixture(fixtureId)?.resolveMoment(identity) ?? null,
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
