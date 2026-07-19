import { randomUUID } from "node:crypto";

import type {
  CommentaryArtifactRepository,
  FixtureReadRepository,
} from "@matchsense/db";

import {
  createAudioHub,
  type AudioHub,
  type AudioWritable,
} from "./audio-hub.js";

type ListeningHub = Pick<
  AudioHub,
  "addClient" | "inject" | "removeClient" | "start" | "stop"
>;

interface LiveMoment {
  familyId: string;
  fixtureId: string;
  identity: string;
  kind: string;
  revision: number;
  status: string;
}

export interface LiveListeningSession {
  awayTeam: string;
  createdAt: string;
  fixtureId: string;
  homeTeam: string;
  id: string;
  perspectiveTeam: string;
  sourceLabel: "TXLINE · LIVE";
  state: "listening";
}

interface OwnedSession extends LiveListeningSession {
  fanId: string;
}

interface PendingMoment {
  cueDelivered: boolean;
  moment: LiveMoment;
}

interface FixtureState {
  cursor: number;
  pendingByFamily: Map<string, PendingMoment>;
  sessionIds: Set<string>;
}

export interface LiveListeningService {
  attach(sessionId: string, fanId: string, client: AudioWritable): boolean;
  createSession(input: {
    fanId: string;
    fixtureId: string;
    perspectiveTeam: string;
  }): Promise<LiveListeningSession | null>;
  pollOnce(): Promise<void>;
  removeSession(sessionId: string, fanId: string): boolean;
  session(sessionId: string, fanId: string): LiveListeningSession | null;
  stop(): void;
}

const commentaryKinds = new Set(["goal", "card.red", "phase.full_time"]);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function momentFromPayload(value: unknown): LiveMoment | null {
  const payload = object(value);
  const candidate = object(payload?.moment);
  if (
    !candidate ||
    typeof candidate.familyId !== "string" ||
    typeof candidate.fixtureId !== "string" ||
    typeof candidate.identity !== "string" ||
    typeof candidate.kind !== "string" ||
    !Number.isSafeInteger(candidate.revision) ||
    typeof candidate.status !== "string"
  ) {
    return null;
  }
  return candidate as unknown as LiveMoment;
}

function isTerminalProjection(payload: unknown) {
  const projection = object(payload);
  return projection?.phase === "full_time";
}

export function createLiveListeningService(options: {
  artifacts: Pick<CommentaryArtifactRepository, "get">;
  audioHub?: ListeningHub;
  createMediaChunks?: ((bytes: Buffer) => readonly Buffer[]) | undefined;
  cueBytes?: Buffer | undefined;
  id?: (() => string) | undefined;
  now?: (() => Date) | undefined;
  pollIntervalMs?: number | undefined;
  reads: Pick<FixtureReadRepository, "getFixture" | "readFixtureFeed">;
  silenceBytes?: Buffer | undefined;
  writeIntervalMs?: number | undefined;
}): LiveListeningService {
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const hub =
    options.audioHub ??
    createAudioHub({
      ...(options.createMediaChunks
        ? { createMediaChunks: options.createMediaChunks }
        : {}),
      cueBytes: options.cueBytes ?? Buffer.alloc(0),
      silenceBytes: options.silenceBytes ?? Buffer.alloc(0),
      writeIntervalMs: options.writeIntervalMs ?? 1_000,
    });
  const sessions = new Map<string, OwnedSession>();
  const fixtures = new Map<string, FixtureState>();
  let polling = false;

  hub.start();

  const publicSession = (session: OwnedSession): LiveListeningSession => {
    const { fanId: _fanId, ...view } = session;
    return view;
  };

  const pollOnce = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const [fixtureId, state] of fixtures) {
        if (state.sessionIds.size === 0) continue;
        const feed = await options.reads.readFixtureFeed({
          afterSequence: state.cursor,
          fixtureId,
          mode: "live",
        });
        if (!feed) continue;
        for (const event of feed.events) {
          const moment = momentFromPayload(event.payload);
          if (!moment || moment.fixtureId !== fixtureId) continue;
          state.pendingByFamily.delete(moment.familyId);
          if (
            moment.status === "confirmed" &&
            commentaryKinds.has(moment.kind)
          ) {
            state.pendingByFamily.set(moment.familyId, {
              cueDelivered: false,
              moment,
            });
          }
        }
        state.cursor = Math.max(state.cursor, feed.highWaterSequence);

        const targetSessions = [...state.sessionIds];
        for (const [familyId, pending] of state.pendingByFamily) {
          const { moment } = pending;
          if (!pending.cueDelivered) {
            pending.cueDelivered = hub.inject(
              `live:cue:${fixtureId}:${moment.identity}`,
              targetSessions,
            );
          }
          const artifact = await options.artifacts.get({
            fixtureId,
            language: "en",
            mode: "live",
            momentId: moment.familyId,
            momentRevision: moment.revision,
            templateVersion: "factual-v1",
            voice: "Kore",
          });
          if (!artifact || artifact.bytes.byteLength === 0) continue;
          if (
            hub.inject(
              `live:speech:${fixtureId}:${moment.identity}`,
              targetSessions,
              Buffer.from(artifact.bytes),
            )
          ) {
            state.pendingByFamily.delete(familyId);
          }
        }
      }
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(
    () => void pollOnce().catch(() => undefined),
    options.pollIntervalMs ?? 1_500,
  );
  timer.unref?.();

  return {
    attach(sessionId, fanId, client) {
      const session = sessions.get(sessionId);
      return session?.fanId === fanId ? hub.addClient(sessionId, client) : false;
    },

    async createSession(input) {
      const fixture = await options.reads.getFixture({
        fixtureId: input.fixtureId,
        mode: "live",
      });
      if (
        !fixture ||
        fixture.provenance !== "live_txline" ||
        fixture.bucket === "final" ||
        isTerminalProjection(fixture.projection?.payload) ||
        (input.perspectiveTeam !== fixture.teams.home &&
          input.perspectiveTeam !== fixture.teams.away)
      ) {
        return null;
      }
      let fixtureState = fixtures.get(input.fixtureId);
      if (!fixtureState) {
        const feed = await options.reads.readFixtureFeed({
          afterSequence: null,
          fixtureId: input.fixtureId,
          mode: "live",
        });
        if (!feed) return null;
        fixtureState = {
          cursor: feed.highWaterSequence,
          pendingByFamily: new Map(),
          sessionIds: new Set(),
        };
        fixtures.set(input.fixtureId, fixtureState);
      }
      const session: OwnedSession = {
        awayTeam: fixture.teams.away,
        createdAt: now().toISOString(),
        fanId: input.fanId,
        fixtureId: input.fixtureId,
        homeTeam: fixture.teams.home,
        id: id(),
        perspectiveTeam: input.perspectiveTeam,
        sourceLabel: "TXLINE · LIVE",
        state: "listening",
      };
      sessions.set(session.id, session);
      fixtureState.sessionIds.add(session.id);
      return publicSession(session);
    },

    pollOnce,

    removeSession(sessionId, fanId) {
      const session = sessions.get(sessionId);
      if (!session || session.fanId !== fanId) return false;
      sessions.delete(sessionId);
      hub.removeClient(sessionId);
      const fixture = fixtures.get(session.fixtureId);
      fixture?.sessionIds.delete(sessionId);
      if (fixture?.sessionIds.size === 0) fixtures.delete(session.fixtureId);
      return true;
    },

    session(sessionId, fanId) {
      const session = sessions.get(sessionId);
      return session?.fanId === fanId ? publicSession(session) : null;
    },

    stop() {
      clearInterval(timer);
      sessions.clear();
      fixtures.clear();
      hub.stop();
    },
  };
}
