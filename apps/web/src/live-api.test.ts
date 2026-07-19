import { afterEach, describe, expect, it, vi } from "vitest";

import {
  eventLabel,
  fetchMomentResolution,
  fixtureState,
  normalizeCatalog,
  normalizeFixture,
  parseCanonicalEvent,
  parseCommentaryEvent,
  todayFixtureBucket,
} from "./live-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("live product API normalization", () => {
  it("renders dynamic catalog teams instead of enforcing a fixed team enum", () => {
    const catalog = normalizeCatalog({
      sourceLabel: "TXLINE · DEVNET SOURCE",
      teams: [
        {
          code: "MAR",
          colors: { primary: "#c1272d", secondary: "#006233" },
          name: "Morocco",
        },
      ],
    });

    expect(catalog.teams).toEqual([
      expect.objectContaining({ code: "MAR", name: "Morocco" }),
    ]);
  });

  it("accepts both team objects and legacy string codes in fixture responses", () => {
    const fixture = normalizeFixture({
      awayTeam: "MEX",
      fixtureId: "wc-final",
      homeTeam: { code: "ARG", name: "Argentina" },
      kickoffAt: "2026-07-19T19:00:00.000Z",
      minute: "67′",
      phase: "second_half",
      score: { away: 1, home: 2 },
    });

    expect(fixture).toMatchObject({
      awayTeam: "MEX",
      fixtureId: "wc-final",
      homeTeam: "ARG",
      homeTeamName: "Argentina",
      score: { away: 1, home: 2 },
    });
    expect(fixtureState(fixture!, Date.parse("2026-07-19T20:00:00.000Z"))).toBe(
      "live",
    );
  });

  it("does not infer a final result from an old kickoff time", () => {
    const fixture = normalizeFixture({
      awayTeam: "FRA",
      fixtureId: "waiting-for-terminal-fact",
      homeTeam: "ARG",
      kickoffAt: "2026-07-18T08:00:00.000Z",
      minute: "—",
      phase: "scheduled",
      score: { away: 0, home: 0 },
    });

    expect(fixtureState(fixture!, Date.parse("2026-07-18T22:00:00.000Z"))).toBe(
      "upcoming",
    );
  });

  it("does not surface an unqualified fixture in Today buckets", () => {
    const fixture = normalizeFixture({
      awayTeam: "FRA",
      fixtureId: "unqualified",
      homeTeam: "ARG",
      minute: "—",
      phase: "scheduled",
      score: { away: 0, home: 0 },
    });

    expect(todayFixtureBucket(fixture!)).toBeNull();
  });

  it("does not invent a scheduled phase when the API omits one", () => {
    const fixture = normalizeFixture({
      awayTeam: "FRA",
      fixtureId: "phase-missing",
      homeTeam: "ARG",
      score: { away: 0, home: 0 },
    });

    expect(fixture?.phase).toBeUndefined();
  });

  it("normalizes an archive-qualified durable fixture without inventing a score", () => {
    const fixture = normalizeFixture({
      archiveManifestId: "archive-2026-final",
      fixtureId: "fx-final",
      lifecycle: "final",
      mode: "live",
      projection: {
        payload: {
          lastEvent: {
            eventTeam: "ARG",
            id: "goal-family",
            identity: "goal-family:4",
            kind: "goal",
            minute: "81'",
            revision: 4,
            score: { away: 1, home: 2 },
            status: "confirmed",
          },
          minute: "FT",
          phase: "full_time",
          score: { away: 1, home: 2 },
        },
        revision: 9,
        sourceSequence: "1026",
        updatedAt: "2026-07-18T15:00:00.000Z",
      },
      provenance: "live_txline",
      replayReady: true,
      scheduledAt: "2026-07-18T12:00:00.000Z",
      teams: { away: "FRA", home: "ARG" },
    });

    expect(fixture).toMatchObject({
      archiveStatus: "REPLAY_READY",
      awayTeam: "FRA",
      fixtureId: "fx-final",
      homeTeam: "ARG",
      lifecycle: "FINAL",
      mode: "live",
      provenance: "live_txline",
      score: { away: 1, home: 2 },
    });
    expect(fixture?.lastEvent?.identity).toBe("goal-family:4");
  });

  it("keeps a durable scheduled fixture scoreless when no projection exists", () => {
    const fixture = normalizeFixture({
      fixtureId: "fx-scheduled",
      lifecycle: "scheduled",
      mode: "live",
      projection: null,
      provenance: "live_txline",
      replayReady: false,
      scheduledAt: "2026-07-19T12:00:00.000Z",
      teams: { away: "MEX", home: "ARG" },
    });

    expect(fixture).toMatchObject({
      awayTeam: "MEX",
      homeTeam: "ARG",
      lifecycle: "SCHEDULED",
      score: null,
    });
  });

  it("lets a newer TxLINE projection phase outrank a stale schedule row", () => {
    const fixture = normalizeFixture({
      fixtureId: "fx-live",
      lifecycle: "scheduled",
      mode: "live",
      projection: {
        payload: {
          awayTeam: "ENG",
          fixtureId: "fx-live",
          homeTeam: "FRA",
          minute: "18'",
          phase: "first_half",
          revision: 3,
          score: { away: 0, home: 1 },
        },
        revision: 3,
      },
      provenance: "live_txline",
      teams: { away: "ENG", home: "FRA" },
    });

    expect(fixture?.lifecycle).toBe("LIVE");
    expect(todayFixtureBucket(fixture!)).toBe("live");
  });

  it("normalizes a canonical SSE Moment without losing its revision identity", () => {
    const payload = parseCanonicalEvent(
      JSON.stringify({
        event: "moment.created",
        id: "stream:42",
        moment: {
          celebratesGoal: true,
          eventTeam: "ESP",
          id: "fixture:goal:42",
          identity: "fixture:goal:42:3",
          kind: "goal",
          minute: "82′",
          revision: 3,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
        snapshot: {
          awayTeam: "FRA",
          fixtureId: "fixture",
          homeTeam: "ESP",
          minute: "82′",
          phase: "second_half",
          score: { away: 0, home: 1 },
        },
      }),
    );

    expect(payload?.moment).toMatchObject({
      celebratesGoal: true,
      identity: "fixture:goal:42:3",
    });
    expect(eventLabel(payload!.moment)).toBe("Goal");
  });

  it("preserves the authored provider on stored Experience commentary", () => {
    const payload = parseCommentaryEvent(
      JSON.stringify({
        commentary: {
          generatedAt: "2026-07-19T10:00:00.000Z",
          language: "en",
          momentIdentity: "experience:goal:1",
          provider: "authored",
          text: "Argentina lead France two goals to one.",
          usedFallback: false,
        },
        event: "commentary.ready",
        id: "commentary:experience:goal:1",
        snapshot: {
          awayTeam: "FRA",
          fixtureId: "experience",
          homeTeam: "ARG",
          minute: "81'",
          phase: "second_half",
          score: { away: 1, home: 2 },
        },
      }),
    );

    expect(payload?.commentary.provider).toBe("authored");
  });

  it.each([
    ["phase.kickoff", "phase.kickoff", "Kickoff"],
    ["phase.var", "phase.var", "VAR review"],
    ["var.started", "VAR.STARTED", "VAR review"],
    ["var.stands", undefined, "VAR decision stands"],
    ["var.overturned", undefined, "VAR decision overturned"],
    ["phase.penalty", "phase.penalty", "Penalty awarded"],
    ["penalty.awarded", undefined, "Penalty awarded"],
    ["penalty.scored", undefined, "Penalty scored"],
    ["card.yellow", undefined, "Yellow card"],
    ["card.red", undefined, "Red card"],
    ["phase.half_time", undefined, "Half time"],
    ["phase.second_half_start", undefined, "Second half"],
    ["phase.full_time", undefined, "Full time"],
  ])(
    "renders %s as a plain-English action even when the feed title is technical",
    (kind, title, expected) => {
      expect(
        eventLabel({
          celebratesGoal: false,
          eventTeam: "ARG",
          id: `event-${kind}`,
          identity: `event-${kind}:1`,
          kind,
          minute: "23'",
          revision: 1,
          score: { away: 0, home: 0 },
          status: "confirmed",
          ...(title ? { title } : {}),
        }),
      ).toBe(expected);
    },
  );

  it("keeps a useful fan-facing event title", () => {
    expect(
      eventLabel({
        celebratesGoal: true,
        eventTeam: "ARG",
        id: "goal-one",
        identity: "goal-one:1",
        kind: "goal",
        minute: "23'",
        revision: 1,
        score: { away: 0, home: 1 },
        status: "confirmed",
        title: "Argentina take the lead",
      }),
    ).toBe("Argentina take the lead");
  });

  it("requests the exact Moment identity and preserves current corrected truth", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            latest: {
              eventTeam: "ARG",
              id: "fixture:event:goal-1",
              identity: "fixture:event:goal-1:4",
              kind: "var.overturned",
              minute: "24′",
              revision: 4,
              score: { away: 0, home: 0 },
              status: "overturned",
            },
            requested: {
              eventTeam: "ARG",
              id: "fixture:event:goal-1",
              identity: "fixture:event:goal-1:3",
              kind: "goal",
              minute: "23′",
              revision: 3,
              score: { away: 0, home: 1 },
              status: "confirmed",
            },
            snapshot: {
              awayTeam: "FRA",
              fixtureId: "fixture",
              homeTeam: "ARG",
              minute: "24′",
              phase: "first_half",
              revision: 4,
              score: { away: 0, home: 0 },
            },
            superseded: true,
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const resolution = await fetchMomentResolution(
      "fixture",
      "fixture:event:goal-1:3",
    );

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/fixtures/fixture/moments/fixture%3Aevent%3Agoal-1%3A3",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(resolution).toMatchObject({
      latest: { identity: "fixture:event:goal-1:4", status: "overturned" },
      requested: { identity: "fixture:event:goal-1:3" },
      snapshot: { score: { away: 0, home: 0 } },
      superseded: true,
    });
  });

  it("parses durable revision envelopes without treating revision metadata as a Moment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              latest: {
                createdAt: "2026-07-18T14:20:00.000Z",
                payload: {
                  eventTeam: "ARG",
                  id: "goal-family",
                  identity: "goal-family:4",
                  kind: "var.overturned",
                  minute: "24'",
                  revision: 4,
                  score: { away: 0, home: 0 },
                  status: "overturned",
                },
                revision: 4,
                sourceRecordId: "source-4",
              },
              requested: {
                createdAt: "2026-07-18T14:19:00.000Z",
                payload: {
                  eventTeam: "ARG",
                  id: "goal-family",
                  identity: "goal-family:3",
                  kind: "goal",
                  minute: "23'",
                  revision: 3,
                  score: { away: 0, home: 1 },
                  status: "confirmed",
                },
                revision: 3,
                sourceRecordId: "source-3",
              },
              snapshot: {
                archiveManifestId: "archive-ready",
                fixtureId: "fixture",
                lifecycle: "live",
                mode: "live",
                projection: {
                  payload: { minute: "24'", score: { away: 0, home: 0 } },
                  revision: 4,
                  sourceSequence: "4",
                  updatedAt: "2026-07-18T14:20:00.000Z",
                },
                provenance: "live_txline",
                replayReady: false,
                scheduledAt: "2026-07-18T14:00:00.000Z",
                teams: { away: "FRA", home: "ARG" },
              },
              superseded: true,
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      fetchMomentResolution("fixture", "goal-family:3"),
    ).resolves.toMatchObject({
      latest: { identity: "goal-family:4", status: "overturned" },
      requested: { identity: "goal-family:3" },
      superseded: true,
    });
  });
});
