import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FanProfile } from "../fan-profile.js";
import type { MomentResolution, ProductCatalog } from "../live-api.js";
import type { VerifiedFixtureMemory } from "../memory-api.js";
import type { LiveSnapshot } from "../product-state.js";
import type { RecordedReplayTimeline } from "../replay-api.js";

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
    expect(markup).not.toContain("DEMO MODE");
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
});
