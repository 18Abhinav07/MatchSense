import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "./config.js";
import { experienceTeamCatalog, startApi } from "./api-main.js";

async function temporaryWebShell() {
  const directory = await mkdtemp(path.join(tmpdir(), "matchsense-api-"));
  await mkdir(path.join(directory, "assets"));
  await writeFile(
    path.join(directory, "index.html"),
    "<!doctype html><title>MatchSense</title>",
  );
  return directory;
}

describe("API-only runtime", () => {
  it("adapts every persisted tournament team for Experience commentary", () => {
    expect(
      experienceTeamCatalog([
        {
          code: "ARG",
          name: "Argentina",
          participantId: "team-arg",
        },
        {
          code: "MAR",
          name: "Morocco",
          participantId: "team-mar",
        },
      ]),
    ).toEqual([
      {
        code: "ARG",
        colors: { primary: "#75AADB", secondary: "#F3EFE4" },
        name: "Argentina",
        participantId: "team-arg",
      },
      {
        code: "MAR",
        colors: { primary: "#164C36", secondary: "#D8F279" },
        name: "Morocco",
        participantId: "team-mar",
      },
    ]);
  });

  it("boots static/readiness routes without migrations or public demo routes", async () => {
    const webDistPath = await temporaryWebShell();
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      fans: {},
      migrate: vi.fn(async () => undefined),
      pushDevices: {},
    };

    try {
      const app = await startApi(
        parseServerEnv({
          DATABASE_URL: "postgresql://db.example/matchsense",
          ROLE: "api",
        }),
        { databaseRuntime: database as never, listen: false, webDistPath },
      );

      expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/demo/sessions",
          })
        ).statusCode,
      ).toBe(404);
      expect((await app.inject({ url: "/demo" })).statusCode).toBe(404);
      expect(database.migrate).not.toHaveBeenCalled();
      await app.close();
      expect(database.close).toHaveBeenCalledOnce();
    } finally {
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("serves the persisted live catalogue and fixtures through the credential-free API role", async () => {
    const webDistPath = await temporaryWebShell();
    const fixture = {
      archiveManifestId: null,
      bucket: "upcoming" as const,
      fixtureId: "fixture-arg-fra",
      lifecycle: "scheduled" as const,
      metadata: {
        participant1: { id: "team-arg", name: "Argentina" },
        participant1IsHome: true,
        participant2: { id: "team-fra", name: "France" },
        sourceTimestampMs: 1_784_403_000_000,
      },
      mode: "live" as const,
      projection: null,
      provenance: "live_txline" as const,
      replayReady: false,
      scheduledAt: "2026-07-18T18:00:00.000Z",
      teams: { away: "FRA", home: "ARG" },
    };
    const fixtureReads = {
      getFixture: vi.fn(async () => fixture),
      getReplayReady: vi.fn(async () => null),
      listFixtures: vi.fn(async () => [fixture]),
      readFixtureFeed: vi.fn(async () => null),
      readHistory: vi.fn(async () => []),
      readMemory: vi.fn(async () => null),
      readMoment: vi.fn(async () => null),
    };
    const teamCatalog = {
      list: vi.fn(async () => [
        {
          code: "ARG",
          name: "Argentina",
          participantId: "team-arg",
          sourceTimestampMs: 1_784_403_000_000,
        },
        {
          code: "FRA",
          name: "France",
          participantId: "team-fra",
          sourceTimestampMs: 1_784_403_000_000,
        },
      ]),
    };
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      fans: {},
      fixtureReads,
      pushDevices: {},
      teamCatalog,
    };

    try {
      const app = await startApi(
        parseServerEnv({
          DATABASE_URL: "postgresql://db.example/matchsense",
          ROLE: "api",
        }),
        { databaseRuntime: database as never, listen: false, webDistPath },
      );

      const [catalogue, fixtures] = await Promise.all([
        app.inject({ url: "/api/v1/catalog" }),
        app.inject({ url: "/api/v1/fixtures" }),
      ]);

      expect(catalogue.statusCode).toBe(200);
      expect(catalogue.headers["cache-control"]).toBe("no-store");
      expect(catalogue.json()).toMatchObject({
        provenance: "live_txline",
        teams: [
          { code: "ARG", name: "Argentina" },
          { code: "FRA", name: "France" },
        ],
      });
      expect(catalogue.json()).toEqual({
        provenance: "live_txline",
        sourceLabel: "TXLINE · WORLD CUP DATA",
        teams: [
          { code: "ARG", name: "Argentina" },
          { code: "FRA", name: "France" },
        ],
      });
      expect(fixtures.statusCode).toBe(200);
      expect(fixtures.headers["cache-control"]).toBe("no-store");
      expect(fixtures.json()).toEqual({ fixtures: [fixture] });
      expect(fixtureReads.listFixtures).toHaveBeenCalledWith({ mode: "live" });
      expect(teamCatalog.list).toHaveBeenCalledOnce();
      await app.close();
    } finally {
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("exposes ready live commentary artifacts through the credential-free API role", async () => {
    const webDistPath = await temporaryWebShell();
    const fixtureId = "fixture-arg-fra";
    const familyId = "txline:fixture-arg-fra:action:goal-23";
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      commentaryArtifacts: {
        get: vi.fn(async () => ({
          bytes: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
          createdAt: "2026-07-18T12:23:00.000Z",
          fixtureId,
          id: "audio-1",
          language: "en",
          mediaType: "audio/mpeg",
          mode: "live",
          momentId: familyId,
          momentRevision: 3,
          templateVersion: "factual-v1",
          updatedAt: "2026-07-18T12:23:00.000Z",
          voice: "Kore",
        })),
      },
      fans: {},
      fixtureTruth: {
        eventsAfter: vi.fn(async () => [
          {
            createdAt: "2026-07-18T12:23:00.000Z",
            eventId: `${fixtureId}:revision:3`,
            eventType: "moment.created",
            fixtureId,
            mode: "live",
            payload: {
              event: "moment.created",
              moment: {
                familyId,
                fixtureId,
                revision: 3,
                status: "confirmed",
              },
            },
            sequence: 1,
          },
        ]),
      },
      pushDevices: {},
    };

    try {
      const app = await startApi(
        parseServerEnv({
          DATABASE_URL: "postgresql://db.example/matchsense",
          ROLE: "api",
        }),
        { databaseRuntime: database as never, listen: false, webDistPath },
      );
      const response = await app.inject({
        url: `/api/v1/fixtures/${fixtureId}/moments/${familyId}:3/audio`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("audio/mpeg");
      await app.close();
    } finally {
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("wires durable Call Three creation to a persisted scheduled live fixture", async () => {
    const webDistPath = await temporaryWebShell();
    const fixtureId = "fixture-arg-fra";
    let session: {
      csrfHash: string;
      expiresAt: string;
      sessionHash: string;
    } | null = null;
    const fan = {
      avatarVariant: null,
      createdAt: "2026-07-18T12:00:00.000Z",
      deletedAt: null,
      favoriteTeam: "ARG",
      handle: "abhinav",
      handleNormalized: "abhinav",
      id: "",
      preferences: {},
      profile: {},
      updatedAt: "2026-07-18T12:00:00.000Z",
    };
    const fans = {
      createGuest: vi.fn(async (input) => {
        session = input;
        fan.id = input.fanId;
        return { ...fan };
      }),
      resolveSession: vi.fn(async ({ sessionHash }) => {
        const stored = session;
        if (!stored || stored.sessionHash !== sessionHash) return null;
        return {
          csrfHash: stored.csrfHash,
          expiresAt: stored.expiresAt,
          fan: { ...fan },
          lastSeenAt: fan.updatedAt,
          revokedAt: null,
          sessionHash,
        };
      }),
      upsertFollow: vi.fn(async () => undefined),
    };
    const rooms = {
      create: vi.fn(async (input) => ({
        aggregate: input.aggregate,
        createdAt: "2026-07-18T12:00:00.000Z",
        finalizedAt: null,
        fixtureId: input.fixtureId,
        id: input.id,
        inviteExpiresAt: input.inviteExpiresAt,
        inviteHash: input.inviteHash,
        mode: input.mode,
        ownerFanId: input.host.fanId,
        status: input.status,
        updatedAt: "2026-07-18T12:00:00.000Z",
        version: 0,
      })),
      listForFan: vi.fn(async () => []),
    };
    const fixtureTruth = {
      get: vi.fn(async () => ({
        awayTeamId: "FRA",
        createdAt: "2026-07-18T12:00:00.000Z",
        homeTeamId: "ARG",
        id: fixtureId,
        metadata: {},
        mode: "live",
        provenance: "live_txline",
        scheduledAt: "2099-07-18T18:00:00.000Z",
        status: "scheduled",
        updatedAt: "2026-07-18T12:00:00.000Z",
      })),
      getLatestProjection: vi.fn(async () => null),
    };
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      fans,
      fixtureTruth,
      pushDevices: {},
      rooms,
    };

    try {
      const app = await startApi(
        parseServerEnv({
          DATABASE_URL: "postgresql://db.example/matchsense",
          ROLE: "api",
        }),
        { databaseRuntime: database as never, listen: false, webDistPath },
      );
      const guest = await app.inject({
        method: "POST",
        url: "/api/v1/session/guest",
      });
      const cookies = guest.headers["set-cookie"] as string[];
      const cookie = cookies.map((entry) => entry.split(";", 1)[0]).join("; ");
      const csrf = cookies
        .find((entry) => entry.startsWith("matchsense_csrf="))!
        .split(";", 1)[0]!
        .split("=")[1]!;
      const response = await app.inject({
        headers: { cookie, "x-matchsense-csrf": csrf },
        method: "POST",
        payload: {
          fixtureId,
          host: { nickname: "Abhinav", teamCode: "ARG" },
          name: "Final night",
        },
        url: "/api/v1/rooms",
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        room: {
          fixture: {
            fixtureId,
            provenance: "live_txline",
            phase: "scheduled",
          },
          status: "PRE_KICKOFF",
        },
      });
      expect(fixtureTruth.get).toHaveBeenCalledWith({
        fixtureId,
        mode: "live",
      });
      expect(fans.upsertFollow).toHaveBeenCalledWith({
        eventPreferences: {
          fullTime: true,
          goals: true,
          halfTime: true,
          penalties: true,
          redCards: true,
          var: true,
          yellowCards: true,
        },
        fanId: fan.id,
        fixtureId,
        mode: "live",
      });
      await app.close();
    } finally {
      await rm(webDistPath, { force: true, recursive: true });
    }
  });
});
