import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FanProfile } from "../fan-profile.js";
import type { MomentResolution, ProductCatalog } from "../live-api.js";
import type { VerifiedFixtureMemory } from "../memory-api.js";
import type { LiveSnapshot } from "../product-state.js";
import type { RecordedReplayTimeline } from "../replay-api.js";
import type { CallThreeRoomView } from "../features/rooms/types.js";

import { AppRouter, type AppRouterProps } from "./AppRouter.js";

const catalog: ProductCatalog = {
  teams: [
    {
      code: "ARG",
      name: "Argentina",
      primary: "#78bde9",
      secondary: "#ffffff",
    },
    {
      code: "FRA",
      name: "France",
      primary: "#174c9a",
      secondary: "#ffffff",
    },
  ],
};

const profile: FanProfile = {
  avatarVariant: "arg-pulse",
  createdAt: "2026-07-18T00:00:00.000Z",
  deletedAt: null,
  favoriteTeam: "ARG",
  handle: "matchfan",
  handleNormalized: "matchfan",
  id: "fan-42",
  preferences: {},
  profile: {},
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const fixture: LiveSnapshot = {
  awayTeam: "FRA",
  fixtureId: "arg-fra",
  freshness: "live",
  homeTeam: "ARG",
  lifecycle: "LIVE",
  minute: "23'",
  provenance: "live_txline",
  score: { away: 0, home: 1 },
};

const upcomingRoomFixture: LiveSnapshot = {
  awayTeam: "FRA",
  fixtureId: "room-fixture",
  kickoffAt: "2099-07-19T19:00:00.000Z",
  homeTeam: "ARG",
  lifecycle: "SCHEDULED",
  minute: "—",
  mode: "live",
  provenance: "live_txline",
  score: null,
};

const recordedFixture: LiveSnapshot = {
  archiveManifestId: "archive-arg-fra",
  archiveStatus: "REPLAY_READY",
  awayTeam: "FRA",
  fixtureId: "arg-fra",
  homeTeam: "ARG",
  lifecycle: "FINAL",
  minute: "FT",
  mode: "recorded",
  provenance: "recorded_txline_authorised",
  score: { away: 1, home: 2 },
};

const memory: VerifiedFixtureMemory = {
  archiveManifestId: "archive-arg-fra",
  fixture: recordedFixture as VerifiedFixtureMemory["fixture"],
  timeline: [],
};

const momentResolution: MomentResolution = {
  latest: {
    celebratesGoal: true,
    eventTeam: "ARG",
    id: "goal-1",
    identity: "goal-1:1",
    kind: "goal",
    minute: "23'",
    revision: 1,
    score: { away: 0, home: 1 },
    status: "confirmed",
  },
  requested: null,
  snapshot: fixture,
  superseded: false,
};

const replay: RecordedReplayTimeline = {
  archiveManifestId: "archive-arg-fra",
  events: [],
  fixtureId: "arg-fra",
  fixtureMode: "recorded",
  highWaterSequence: 0,
  id: "recorded_YXJnLWZyYQ.YXJjaGl2ZS1hcmctZnJh",
  mode: "recorded",
  replaySeq: 0,
  snapshot: recordedFixture as RecordedReplayTimeline["snapshot"],
};

const roomFixture = {
  awayTeam: "FRA",
  fixtureId: "room-fixture",
  homeTeam: "ARG",
  kickoffAt: "2026-07-19T19:00:00.000Z",
  minute: "—",
  phase: "scheduled",
  provenance: "live_txline" as const,
  revision: 1,
  score: { away: 0, home: 0 },
  sourceLabel: "TXLINE MATCH DATA",
  updatedAt: "2026-07-18T19:00:00.000Z",
};

const room: CallThreeRoomView = {
  createdAt: 1,
  currentMoment: null,
  finalisedAt: null,
  fixture: roomFixture,
  hostParticipantId: "fan-42",
  id: "room-one",
  kickoffAt: Date.parse(roomFixture.kickoffAt),
  leaderboard: [],
  members: [
    {
      hasCalls: false,
      id: "fan-42",
      isHost: true,
      joinedAt: 1,
      lockedAt: null,
      nickname: "matchfan",
      role: "PLAYER",
      teamCode: "ARG",
    },
  ],
  moments: [],
  myCalls: null,
  name: "Final night",
  points: {
    label: "MATCHSENSE POINTS · NON-TRANSFERABLE",
    lifetimeTotal: 0,
    roomPoints: 0,
  },
  reactions: [],
  revision: 1,
  status: "PRE_KICKOFF",
  targets: { cards: null, goals: null, result: null },
  viewerParticipantId: "fan-42",
};

const roomApi = {
  create: async () => ({
    inviteCode: "abcdefghijklmnopqrstuv",
    invitePath: "/rooms/join/abcdefghijklmnopqrstuv",
    room,
  }),
  get: async () => room,
  join: async () => room,
  list: async () => [room],
  lockCalls: async () => room,
  preview: async () => ({
    callsLocked: false,
    expiresAt: room.kickoffAt,
    fixture: roomFixture,
    hostNickname: "matchfan",
    kickoffAt: room.kickoffAt,
    memberCount: 1,
    memberNicknames: ["matchfan"],
    name: "Final night",
    roomId: room.id,
    status: "PRE_KICKOFF" as const,
  }),
  react: async () => ({ reaction: {} as never, room }),
  setCalls: async () => room,
  subscribe: () => () => undefined,
};

function render(props: Partial<AppRouterProps>) {
  return renderToStaticMarkup(
    createElement(AppRouter as FunctionComponent<AppRouterProps>, {
      initialCatalog: catalog,
      initialFixtures: [fixture],
      initialProfile: profile,
      ...props,
    }),
  );
}

describe("truthful application router", () => {
  it("renders Today from supplied server-qualified fixtures", () => {
    const markup = render({ initialPath: "/" });

    expect(markup).toContain("Live now");
    expect(markup).toContain("Argentina");
    expect(markup).toContain("Your profile");
    expect(markup).not.toContain("DEMO MODE");
  });

  it("routes a completed supporter to the editable private profile surface", () => {
    const markup = render({ initialPath: "/you" });

    expect(markup).toContain("YOU · PRIVATE FAN PROFILE");
    expect(markup).toContain("Save profile");
    expect(markup).toContain("Delete profile");
    expect(markup).toContain("Public handle");
    expect(markup).toContain("SUPPORTER ID · fan-42");
    expect(markup).not.toContain("Profile details");
  });

  it("does not invent a fallback team on the editable profile when the catalogue is unavailable", () => {
    const markup = render({
      initialCatalog: { teams: [] },
      initialPath: "/you",
    });

    expect(markup).toContain("Team catalogue unavailable");
    expect(markup).not.toContain("Argentina");
  });

  it("renders the exact Match Hub route without inventing its score", () => {
    const markup = render({ initialPath: "/matches/arg-fra" });

    expect(markup).toContain("Argentina");
    expect(markup).toContain("France");
    expect(markup).toContain("LIVE");
    expect(markup).toContain("Stream unavailable");
  });

  it("does not expose a public demo route", () => {
    const markup = render({ initialPath: "/demo" });

    expect(markup).toContain("YOUR MATCH DAY");
    expect(markup).not.toContain("JUDGED DEMO");
    expect(markup).not.toContain("Open Demo Mode");
  });

  it("routes verified Memory, revision-safe Moments, and recorded replay surfaces", () => {
    const memoryMarkup = render({
      initialMemory: memory,
      initialPath: "/matches/arg-fra/memory",
    });
    const momentMarkup = render({
      initialMomentResolution: momentResolution,
      initialPath: "/matches/arg-fra/moments/goal-1%3A1",
    });
    const replayLibraryMarkup = render({
      initialPath: "/replays",
      initialReplayHistory: [recordedFixture],
    });
    const replayMarkup = render({
      initialPath: "/replays/recorded_YXJnLWZyYQ.YXJjaGl2ZS1hcmctZnJh",
      initialReplayTimeline: replay,
    });

    expect(memoryMarkup).toContain("ARCHIVE VERIFIED");
    expect(momentMarkup).toContain("GOAL CONFIRMED");
    expect(replayLibraryMarkup).toContain("RECORDED REPLAYS");
    expect(replayMarkup).toContain("RECORDED · TXLINE DATA");
  });

  it("routes a durable Call Three Room without exposing retired Experience language", () => {
    const markup = render({
      initialPath: "/rooms/room-one",
      ...({
        initialRoom: room,
        roomApi,
      } as Partial<AppRouterProps>),
    });

    expect(markup).toContain("Final night");
    expect(markup).toContain("Call Three");
    expect(markup).not.toContain("Start Experience");
  });

  it("opens the Call Three creation form from a durable scheduled fixture", () => {
    const markup = render({
      initialFixtures: [upcomingRoomFixture],
      initialPath: "/rooms/new/room-fixture",
      ...({ roomApi } as Partial<AppRouterProps>),
    });

    expect(markup).toContain("Create Call Three Room");
    expect(markup).not.toContain("Call Three unavailable");
  });
});
