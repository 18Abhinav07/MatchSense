import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createProductRuntime } from "./product-runtime.js";

let webDistPath: string;

beforeAll(async () => {
  webDistPath = await mkdtemp(path.join(tmpdir(), "matchsense-product-"));
  await mkdir(path.join(webDistPath, "assets"));
  await writeFile(path.join(webDistPath, "index.html"), "MatchSense");
});

afterAll(async () => {
  await rm(webDistPath, { force: true, recursive: true });
});

const readinessProbe = {
  check: async () => ({ databaseReachable: true, migrationsCurrent: true }),
};

class ReplayAudioClient extends EventEmitter {
  readonly chunks: string[] = [];
  ended = false;
  write(bytes: Buffer) {
    this.chunks.push(bytes.toString());
    return true;
  }
  end() {
    this.ended = true;
  }
}

describe("first vertical product contract", () => {
  it("moves replay through the canonical runtime and injects the same moment into listening", async () => {
    let currentTime = "2026-07-16T12:10:00.000Z";
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      now: () => currentTime,
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const app = buildApp({ readinessProbe, runtime, webDistPath });

    const cold = await app.inject({ url: "/api/v1/fixtures/arg-fra-demo" });
    expect(cold.statusCode).toBe(200);
    expect(cold.json()).toMatchObject({
      fixtureId: "arg-fra-demo",
      provenance: "synthetic_txline_shaped",
      score: { away: 0, home: 0 },
      sourceLabel: "SIMULATION · TXLINE-SHAPED DATA",
      updatedAt: "2026-07-16T12:10:00.000Z",
    });

    const listener = await app.inject({
      method: "POST",
      payload: { perspectiveTeam: "ARG" },
      url: "/api/v1/fixtures/arg-fra-demo/listening-sessions",
    });
    expect(listener.statusCode).toBe(201);
    const listeningSessionId = listener.json().id as string;

    const replay = await app.inject({
      method: "POST",
      payload: { fixtureId: "arg-fra-demo" },
      url: "/api/v1/replay/sessions",
    });
    const replaySessionId = replay.json().id as string;

    const command = async () =>
      app.inject({
        method: "POST",
        payload: { marker: "goal", type: "advance_to_marker" },
        url: `/api/v1/replay/sessions/${replaySessionId}/commands`,
      });
    currentTime = "2026-07-16T12:12:07.000Z";
    const first = await command();
    const duplicate = await command();

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      accepted: true,
      moment: {
        identity: "arg-fra-demo:score:1-0:1",
        revision: 1,
      },
      snapshot: {
        score: { away: 0, home: 1 },
        updatedAt: "2026-07-16T12:12:07.000Z",
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      accepted: false,
      duplicate: true,
    });

    const session = await app.inject({
      url: `/api/v1/listening-sessions/${listeningSessionId}`,
    });
    expect(session.json()).toMatchObject({
      id: listeningSessionId,
      lastMomentIdentity: "arg-fra-demo:score:1-0:1",
      state: "listening",
    });
    expect(runtime.fixtureEvents("arg-fra-demo")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "moment.created",
          id: "arg-fra-demo:score:1-0:1",
        }),
      ]),
    );

    runtime.close();
    await app.close();
  });

  it("delivers the canonical goal over same-origin SSE and the persistent MP3 response", async () => {
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const app = buildApp({ readinessProbe, runtime, webDistPath });
    const sseAbort = new AbortController();
    const audioAbort = new AbortController();

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("missing test address");
      const origin = `http://127.0.0.1:${address.port}`;

      const listenerResponse = await fetch(
        `${origin}/api/v1/fixtures/arg-fra-demo/listening-sessions`,
        {
          body: JSON.stringify({ perspectiveTeam: "ARG" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const listener = (await listenerResponse.json()) as { id: string };
      const replayResponse = await fetch(`${origin}/api/v1/replay/sessions`, {
        body: JSON.stringify({ fixtureId: "arg-fra-demo" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const replay = (await replayResponse.json()) as { id: string };

      const sseResponse = await fetch(
        `${origin}/api/v1/fixtures/arg-fra-demo/stream`,
        { signal: sseAbort.signal },
      );
      const sseReader = sseResponse.body?.getReader();
      const audioResponse = await fetch(
        `${origin}/api/v1/listening-sessions/${listener.id}/stream.mp3`,
        { signal: audioAbort.signal },
      );
      const audioReader = audioResponse.body?.getReader();
      if (!sseReader || !audioReader)
        throw new Error("missing response stream");

      const snapshotChunk = await sseReader.read();
      expect(new TextDecoder().decode(snapshotChunk.value)).toContain(
        "event: snapshot",
      );
      const silenceChunk = await audioReader.read();
      expect(Buffer.from(silenceChunk.value ?? []).toString()).toBe("silence");

      const command = await fetch(
        `${origin}/api/v1/replay/sessions/${replay.id}/commands`,
        {
          body: JSON.stringify({ marker: "goal", type: "advance_to_marker" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      expect(command.status).toBe(202);

      const momentChunk = await sseReader.read();
      const momentText = new TextDecoder().decode(momentChunk.value);
      expect(momentText).toContain("event: moment.created");
      expect(momentText).toContain("arg-fra-demo:score:1-0:1");
      const cueChunk = await audioReader.read();
      expect(Buffer.from(cueChunk.value ?? []).toString()).toBe("cue");
      expect(audioResponse.headers.get("content-type")).toBe("audio/mpeg");
    } finally {
      sseAbort.abort();
      audioAbort.abort();
      runtime.close();
      await app.close();
    }
  });

  it("replays an existing canonical Moment only to the requesting listening session", () => {
    const ids = [
      "listener-requesting",
      "listener-unrelated",
      "replay-first",
      "replay-second",
    ];
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      id: () => ids.shift() ?? "unexpected-id",
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const requesting = runtime.createListeningSession("arg-fra-demo", "ARG");
    const unrelated = runtime.createListeningSession("arg-fra-demo", "FRA");
    if (!requesting || !unrelated) throw new Error("missing listening session");
    const requestingClient = new ReplayAudioClient();
    const unrelatedClient = new ReplayAudioClient();
    runtime.attachListeningClient(requesting.id, requestingClient);
    runtime.attachListeningClient(unrelated.id, unrelatedClient);
    const firstReplay = runtime.createReplaySession("arg-fra-demo");
    const first = runtime.commandReplay(firstReplay.id, {
      marker: "goal",
      type: "advance_to_marker",
    });
    const firstSnapshot = runtime.fixture("arg-fra-demo");
    const secondReplay = runtime.createReplaySession("arg-fra-demo");

    const replayed = runtime.commandReplay(secondReplay.id, {
      listeningSessionId: requesting.id,
      marker: "goal",
      type: "advance_to_marker",
    });

    expect(first.kind).toBe("accepted");
    expect(replayed).toMatchObject({
      kind: "replayed",
      moment: { identity: "arg-fra-demo:score:1-0:1", revision: 1 },
      snapshot: { revision: 1, score: { away: 0, home: 1 } },
    });
    expect(runtime.fixture("arg-fra-demo")).toEqual(firstSnapshot);
    expect(runtime.fixtureEvents("arg-fra-demo")).toHaveLength(1);
    expect(requestingClient.chunks).toEqual(["silence", "cue", "cue"]);
    expect(unrelatedClient.chunks).toEqual(["silence", "cue"]);
    runtime.close();
  });

  it("rejects an unknown replay listening session without consuming the command", () => {
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const replay = runtime.createReplaySession("arg-fra-demo");

    expect(
      runtime.commandReplay(replay.id, {
        listeningSessionId: "missing-session",
        marker: "goal",
        type: "advance_to_marker",
      }),
    ).toEqual({ kind: "invalid_listening_session" });
    expect(
      runtime.commandReplay(replay.id, {
        marker: "goal",
        type: "advance_to_marker",
      }),
    ).toMatchObject({ kind: "accepted" });
    runtime.close();
  });

  it("closes a hijacked audio response on DELETE and during app shutdown", async () => {
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const app = buildApp({ readinessProbe, runtime, webDistPath });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test address");
    const origin = `http://127.0.0.1:${address.port}`;

    const openAudio = async () => {
      const sessionResponse = await fetch(
        `${origin}/api/v1/fixtures/arg-fra-demo/listening-sessions`,
        {
          body: JSON.stringify({ perspectiveTeam: "ARG" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const session = (await sessionResponse.json()) as { id: string };
      const response = await fetch(
        `${origin}/api/v1/listening-sessions/${session.id}/stream.mp3`,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing audio reader");
      await reader.read();
      return { reader, session };
    };

    const first = await openAudio();
    const deleted = await fetch(
      `${origin}/api/v1/listening-sessions/${first.session.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);
    await expect(first.reader.read()).resolves.toMatchObject({ done: true });

    const second = await openAudio();
    await expect(
      Promise.race([
        app.close().then(() => "closed"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("timed-out"), 1_000),
        ),
      ]),
    ).resolves.toBe("closed");
    await expect(second.reader.read()).resolves.toMatchObject({ done: true });
  });

  it("serves the real multi-fixture schedule while keeping replay demo out of the live list", async () => {
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      fixtures: [
        {
          awayTeam: "ENG",
          fixtureId: "18257865",
          homeTeam: "FRA",
          kickoffAt: "2026-07-18T21:00:00.000Z",
          provenance: "live_txline",
        },
        {
          awayTeam: "ARG",
          fixtureId: "18257739",
          homeTeam: "ESP",
          kickoffAt: "2026-07-19T19:00:00.000Z",
          provenance: "live_txline",
        },
      ],
      includeDemoFixture: true,
      mode: "live",
      now: () => "2026-07-17T06:30:00.000Z",
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const app = buildApp({ readinessProbe, runtime, webDistPath });

    const fixtures = await app.inject({ url: "/api/v1/fixtures" });
    expect(fixtures.statusCode).toBe(200);
    expect(fixtures.json()).toMatchObject({
      fixtures: [
        { awayTeam: "ENG", fixtureId: "18257865", homeTeam: "FRA" },
        { awayTeam: "ARG", fixtureId: "18257739", homeTeam: "ESP" },
      ],
    });
    expect(
      (fixtures.json() as { fixtures: Array<{ fixtureId: string }> }).fixtures,
    ).not.toEqual(expect.arrayContaining([{ fixtureId: "arg-fra-demo" }]));

    const catalog = await app.inject({ url: "/api/v1/catalog" });
    expect(catalog.json()).toMatchObject({
      provenance: "live_txline",
      source: { mode: "live", state: "scheduled" },
      teams: expect.arrayContaining([
        expect.objectContaining({ code: "ENG", name: "England" }),
        expect.objectContaining({ code: "ARG", name: "Argentina" }),
      ]),
    });
    expect(
      (await app.inject({ url: "/api/v1/fixtures/18257739" })).json(),
    ).toMatchObject({ fixtureId: "18257739", provenance: "live_txline" });
    expect(
      (await app.inject({ url: "/api/v1/fixtures/arg-fra-demo" })).json(),
    ).toMatchObject({
      fixtureId: "arg-fra-demo",
      provenance: "synthetic_txline_shaped",
    });

    const listening = await app.inject({
      method: "POST",
      payload: { perspectiveTeam: "ENG" },
      url: "/api/v1/fixtures/18257865/listening-sessions",
    });
    expect(listening.statusCode).toBe(201);
    expect(listening.json()).toMatchObject({
      awayTeam: "ENG",
      fixtureId: "18257865",
      homeTeam: "FRA",
      perspectiveTeam: "ENG",
    });

    await app.close();
  });
});
