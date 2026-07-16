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

const teams: TeamSummary[] = [
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

function minuteFromTxlineClock(
  statusId: number | null,
  secondsRemaining: number | null,
) {
  const periods: Record<number, { base: number; duration: number }> = {
    2: { base: 0, duration: 45 * 60 },
    4: { base: 45 * 60, duration: 45 * 60 },
    7: { base: 90 * 60, duration: 15 * 60 },
    9: { base: 105 * 60, duration: 15 * 60 },
  };
  const period = statusId === null ? undefined : periods[statusId];
  if (
    !period ||
    secondsRemaining === null ||
    secondsRemaining < 0 ||
    secondsRemaining > period.duration
  ) {
    return "—";
  }
  return `${Math.floor((period.base + period.duration - secondsRemaining) / 60) + 1}'`;
}

export interface ProductFixture {
  awayTeam: TeamCode;
  fixtureId: string;
  homeTeam: TeamCode;
  kickoffAt: string;
  participant1IsHome?: boolean;
  provenance: "synthetic_txline_shaped" | "live_txline";
}

export function createProductRuntime(options: {
  commentaryPipeline?: Pick<CommentaryPipeline, "generate">;
  silenceBytes: Buffer;
  cueBytes: Buffer;
  fixture?: ProductFixture;
  transcodeCommentary?: (wavBytes: Buffer) => Promise<Buffer>;
  writeIntervalMs: number;
  now?: () => string;
  id?: () => string;
}) {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  const fixtureDefinition: ProductFixture = options.fixture ?? {
    awayTeam: "FRA",
    fixtureId: DEMO_FIXTURE_ID,
    homeTeam: "ARG",
    kickoffAt: "2026-07-16T18:00:00.000Z",
    participant1IsHome: true,
    provenance: "synthetic_txline_shaped",
  };
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

  const trackCommentary = (work: Promise<void>) => {
    pendingCommentary.add(work);
    void work.finally(() => pendingCommentary.delete(work));
  };

  const commentaryInput = (
    moment: CanonicalMoment,
    scoringTeam: TeamCode,
  ): CommentaryInput => {
    const homeTeam = teams.find((team) => team.code === projection.homeTeam);
    const awayTeam = teams.find((team) => team.code === projection.awayTeam);
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
    if (!options.commentaryPipeline) return null;
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
    const moment =
      projection.lastEvent ??
      ({
        eventTeam: projection.homeTeam,
        fixtureId: projection.fixtureId,
        id: `${projection.fixtureId}:score:1-0`,
        identity: `${projection.fixtureId}:score:1-0:${revision}`,
        kind: "goal",
        minute: "23'",
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
          audioHub.inject(`replay:${replay.id}:${canonicalMoment.identity}`, [
            requestedListeningSession.id,
          ]);
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
    const matchingListeners: string[] = [];
    for (const session of listeningSessions.values()) {
      if (session.fixtureId === projection.fixtureId) {
        session.lastMomentIdentity = reduced.moment.identity;
        matchingListeners.push(session.id);
      }
    }
    audioHub.inject(reduced.moment.identity, matchingListeners);
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
      event.fixtureId !== projection.fixtureId ||
      event.action !== "goal" ||
      event.confirmed !== true ||
      event.score === null
    ) {
      return { kind: "ignored" as const };
    }
    const previousScore = projection.score;
    const fact: SourceFact = {
      fixtureId: event.fixtureId,
      minute: minuteFromTxlineClock(event.statusId, event.clockSeconds),
      provenance: "live_txline",
      receivedAt: event.receivedAt,
      score: event.score,
      sourceEnvelopeId: [
        "txline",
        event.fixtureId,
        event.source.observedSeq ?? event.revision,
        event.source.payloadHash,
      ].join(":"),
      type: "score_snapshot",
    };
    const reduced = reduceSourceFact(projection, fact);
    projection = reduced.projection;
    if (!reduced.changed) return { kind: "duplicate" as const };
    if (!reduced.moment) {
      return { kind: "accepted" as const, moment: null, snapshot: snapshot() };
    }
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
          : reduced.moment.score.home > previousScore.home
            ? projection.homeTeam
            : projection.awayTeam;
    scoringTeamByMoment.set(reduced.moment.identity, scoringTeam);
    const streamEvent: FixtureStreamEvent = {
      event: "moment.created",
      id: reduced.moment.identity,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
    publish(streamEvent);
    const matchingListeners = [...listeningSessions.values()]
      .filter((session) => session.fixtureId === event.fixtureId)
      .map((session) => {
        session.lastMomentIdentity = reduced.moment!.identity;
        return session.id;
      });
    audioHub.inject(reduced.moment.identity, matchingListeners);
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
      teams,
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
  };
}

export type ProductRuntime = ReturnType<typeof createProductRuntime>;
