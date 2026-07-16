import { randomUUID } from "node:crypto";

import type {
  FixtureSnapshot,
  FixtureStreamEvent,
  ListeningControllerState,
  ReplayCommand,
  TeamCode,
  TeamSummary,
} from "@matchsense/contracts";
import { SIMULATION_SOURCE_LABEL } from "@matchsense/contracts";
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
import { adaptSyntheticEnvelope } from "@matchsense/txline-adapter";

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
  id: string;
  fixtureId: string;
  perspectiveTeam: TeamCode;
  state: ListeningControllerState;
  createdAt: string;
  lastMomentIdentity: string | null;
}

type FixtureSubscriber = (event: FixtureStreamEvent) => void;

export function createProductRuntime(options: {
  silenceBytes: Buffer;
  cueBytes: Buffer;
  writeIntervalMs: number;
  now?: () => string;
  id?: () => string;
}) {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  let projection = createFixtureProjection({
    awayTeam: "FRA",
    fixtureId: DEMO_FIXTURE_ID,
    homeTeam: "ARG",
    kickoffAt: "2026-07-16T18:00:00.000Z",
    observedAt: now(),
  });
  const replaySessions = new Map<string, ReplaySession>();
  const listeningSessions = new Map<string, ListeningSessionView>();
  const fixtureSubscribers = new Map<string, Set<FixtureSubscriber>>();
  const eventLog = new Map<string, FixtureStreamEvent[]>();
  const audioHub: AudioHub = createAudioHub(options);
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

  const fixture = (fixtureId: string): FixtureSnapshot | null =>
    fixtureId === projection.fixtureId ? snapshot() : null;

  const createListeningSession = (
    fixtureId: string,
    perspectiveTeam: TeamCode,
  ) => {
    if (fixtureId !== projection.fixtureId) return null;
    const session: ListeningSessionView = {
      createdAt: now(),
      fixtureId,
      id: id(),
      lastMomentIdentity: null,
      perspectiveTeam,
      state: "listening",
    };
    listeningSessions.set(session.id, session);
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
          audioHub.inject(`replay:${replay.id}:${canonicalMoment.identity}`, [
            requestedListeningSession.id,
          ]);
        }
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
    const matchingListeners: string[] = [];
    for (const session of listeningSessions.values()) {
      if (session.fixtureId === projection.fixtureId) {
        session.lastMomentIdentity = reduced.moment.identity;
        matchingListeners.push(session.id);
      }
    }
    audioHub.inject(reduced.moment.identity, matchingListeners);
    return {
      kind: "accepted" as const,
      moment: reduced.moment,
      snapshot: snapshot(),
    };
  };

  return {
    attachListeningClient: (sessionId: string, client: AudioWritable) =>
      listeningSessions.has(sessionId)
        ? audioHub.addClient(sessionId, client)
        : false,
    catalog: () => ({
      provenance: "synthetic_txline_shaped" as const,
      sourceLabel: SIMULATION_SOURCE_LABEL,
      teams,
    }),
    close: () => audioHub.stop(),
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
