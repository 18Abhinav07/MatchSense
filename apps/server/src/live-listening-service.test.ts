import { describe, expect, it, vi } from "vitest";

import type { AudioWritable } from "./audio-hub.js";
import { createLiveListeningService } from "./live-listening-service.js";

const fixture = {
  archiveManifestId: null,
  bucket: "live" as const,
  fixtureId: "18257739",
  lifecycle: "live" as const,
  metadata: {},
  mode: "live" as const,
  projection: null,
  provenance: "live_txline" as const,
  replayReady: false,
  scheduledAt: "2026-07-19T19:00:00.000Z",
  teams: { away: "ARG", home: "ESP" },
};

const goal = {
  familyId: "goal:esp:1",
  fixtureId: fixture.fixtureId,
  identity: "goal:esp:1:1",
  kind: "goal" as const,
  revision: 1,
  status: "confirmed" as const,
};

describe("live listening service", () => {
  it("starts at the current cursor and fans one ready commentary artifact to every active listener", async () => {
    let highWaterSequence = 8;
    let events: readonly {
      createdAt: string;
      eventId: string;
      eventType: string;
      payload: unknown;
      sequence: number;
    }[] = [];
    let artifactReady = false;
    const inject = vi.fn(() => true);
    const service = createLiveListeningService({
      artifacts: {
        get: vi.fn(async () =>
          artifactReady
            ? ({ bytes: Buffer.from("commentary") } as never)
            : null,
        ),
      },
      audioHub: {
        addClient: vi.fn(() => true),
        inject,
        removeClient: vi.fn(() => true),
        start: vi.fn(() => true),
        stop: vi.fn(() => true),
      },
      reads: {
        getFixture: vi.fn(async () => fixture),
        readFixtureFeed: vi.fn(async ({ afterSequence }) => ({
          events: events.filter((event) => event.sequence > (afterSequence ?? 0)),
          highWaterSequence,
          reset: false,
          snapshot: fixture,
        })),
      },
    });

    const first = await service.createSession({
      fanId: "fan-1",
      fixtureId: fixture.fixtureId,
      perspectiveTeam: "ESP",
    });
    const second = await service.createSession({
      fanId: "fan-2",
      fixtureId: fixture.fixtureId,
      perspectiveTeam: "ARG",
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    events = [
      {
        createdAt: "2026-07-19T19:20:00.000Z",
        eventId: "event-9",
        eventType: "moment.created",
        payload: { event: "moment.created", id: "event-9", moment: goal },
        sequence: 9,
      },
    ];
    highWaterSequence = 9;
    await service.pollOnce();

    expect(inject).toHaveBeenCalledWith(
      `live:cue:${fixture.fixtureId}:${goal.identity}`,
      expect.arrayContaining([first!.id, second!.id]),
    );
    expect(inject).not.toHaveBeenCalledWith(
      expect.stringContaining("speech"),
      expect.anything(),
      expect.anything(),
    );

    artifactReady = true;
    await service.pollOnce();
    expect(inject).toHaveBeenCalledWith(
      `live:speech:${fixture.fixtureId}:${goal.identity}`,
      expect.arrayContaining([first!.id, second!.id]),
      Buffer.from("commentary"),
    );
  });

  it("requires the owner and removes superseded speech before it becomes audible", async () => {
    let highWaterSequence = 0;
    let events: readonly {
      createdAt: string;
      eventId: string;
      eventType: string;
      payload: unknown;
      sequence: number;
    }[] = [];
    const inject = vi.fn(() => true);
    const removeClient = vi.fn(() => true);
    const service = createLiveListeningService({
      artifacts: {
        get: vi.fn(async () => ({ bytes: Buffer.from("stale") }) as never),
      },
      audioHub: {
        addClient: vi.fn(() => true),
        inject,
        removeClient,
        start: vi.fn(() => true),
        stop: vi.fn(() => true),
      },
      reads: {
        getFixture: vi.fn(async () => fixture),
        readFixtureFeed: vi.fn(async ({ afterSequence }) => ({
          events: events.filter((event) => event.sequence > (afterSequence ?? 0)),
          highWaterSequence,
          reset: false,
          snapshot: fixture,
        })),
      },
    });
    const session = await service.createSession({
      fanId: "fan-1",
      fixtureId: fixture.fixtureId,
      perspectiveTeam: "ESP",
    });
    expect(session).not.toBeNull();
    expect(service.session(session!.id, "fan-2")).toBeNull();
    expect(
      service.attach(session!.id, "fan-2", {} as AudioWritable),
    ).toBe(false);

    events = [
      {
        createdAt: "2026-07-19T19:20:00.000Z",
        eventId: "event-1",
        eventType: "moment.created",
        payload: { moment: goal },
        sequence: 1,
      },
      {
        createdAt: "2026-07-19T19:21:00.000Z",
        eventId: "event-2",
        eventType: "moment.revised",
        payload: {
          moment: { ...goal, identity: "goal:esp:1:2", revision: 2, status: "overturned" },
        },
        sequence: 2,
      },
    ];
    highWaterSequence = 2;
    await service.pollOnce();
    expect(inject).not.toHaveBeenCalledWith(
      expect.stringContaining("speech"),
      expect.anything(),
      expect.anything(),
    );

    expect(service.removeSession(session!.id, "fan-2")).toBe(false);
    expect(service.removeSession(session!.id, "fan-1")).toBe(true);
    expect(removeClient).toHaveBeenCalledWith(session!.id);
  });
});
