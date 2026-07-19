import { EventEmitter } from "node:events";

import { createCommentaryPipeline } from "@matchsense/commentary";
import type {
  CanonicalEventFact,
  CanonicalMoment,
  FixtureStreamEvent,
} from "@matchsense/contracts";
import {
  createFixtureProjection,
  reduceSourceFact,
  toFixtureSnapshot,
} from "@matchsense/event-engine";
import { describe, expect, it, vi } from "vitest";

import {
  createProductRuntime,
  isConfirmedGoalMoment,
  isNarratableMoment,
} from "./product-runtime.js";
import type {
  ExperienceAudioAsset,
  ExperienceAudioPack,
} from "./experience-audio-pack.js";

class ListeningClient extends EventEmitter {
  readonly chunks: Buffer[] = [];
  write(bytes: Buffer) {
    this.chunks.push(Buffer.from(bytes));
    return true;
  }
  end() {
    this.emit("close");
  }
}

function canonicalFact(
  fixtureId: string,
  id: string,
  overrides: Partial<CanonicalEventFact>,
): CanonicalEventFact {
  return {
    familyId: id,
    fixtureId,
    kind: "goal",
    minute: "23'",
    occurredAt: "2026-07-16T12:00:00.000Z",
    player: null,
    provenance: "live_txline",
    receivedAt: "2026-07-16T12:00:01.000Z",
    sourceEnvelopeId: id,
    sourceEventId: id,
    status: "confirmed",
    team: "ARG",
    type: "canonical_event",
    ...overrides,
  };
}

function authoredAsset(
  beatKey: string,
  transcript: string,
  bytes: string,
): ExperienceAudioAsset {
  return {
    beatKey,
    bytes: Buffer.from(bytes),
    durationMs: 1_000,
    kind: beatKey === "memory-intro" ? "memory.intro" : "goal",
    minute: beatKey === "memory-intro" ? "MEMORY" : "81'",
    sha256: "a".repeat(64),
    transcript,
  };
}

function authoredPack(): ExperienceAudioPack {
  const winningGoal = authoredAsset(
    "winning-goal",
    "Goal for Argentina! They strike late and lead France two goals to one.",
    "authored-winning-goal",
  );
  const intro = authoredAsset(
    "memory-intro",
    "Here is your MatchSense match summary.",
    "authored-memory-intro",
  );
  return {
    awayTeam: "FRA",
    forMoment: (moment) =>
      moment.provenance === "synthetic_txline_shaped" &&
      moment.sourceEnvelopeId.endsWith(":beat:winning-goal")
        ? { ...winningGoal, bytes: Buffer.from(winningGoal.bytes) }
        : null,
    homeTeam: "ARG",
    locale: "en",
    memoryIntro: intro,
    templateId: "five-minute-match",
    templateVersion: 3,
  };
}

describe("canonical Moment to shared commentary", () => {
  it("allows goal delivery only for confirmed goal moments", () => {
    const goal: CanonicalMoment = {
      celebratesGoal: true,
      eventTeam: "ARG",
      familyId: "goal-1",
      fixtureId: "arg-fra-demo",
      id: "goal-1",
      identity: "goal-1:1",
      kind: "goal",
      minute: "23'",
      occurredAt: "2026-07-16T12:00:00.000Z",
      provenance: "synthetic_txline_shaped",
      revision: 1,
      score: { away: 0, home: 1 },
      sourceEnvelopeId: "goal-envelope-1",
      status: "confirmed",
    };

    expect(isConfirmedGoalMoment(goal)).toBe(true);
    expect(isConfirmedGoalMoment({ ...goal, status: "provisional" })).toBe(
      false,
    );
    expect(isConfirmedGoalMoment({ ...goal, kind: "card.red" })).toBe(false);
    expect(isNarratableMoment({ ...goal, kind: "card.red" })).toBe(true);
    expect(
      isNarratableMoment({
        ...goal,
        eventTeam: null,
        kind: "phase.full_time",
      }),
    ).toBe(true);
  });

  it("delivers one authored Experience asset to every listener without invoking runtime AI", async () => {
    const fixtureId = "experience:authored-runtime";
    const generate = vi.fn(() => {
      throw new Error("Experience must not generate commentary at runtime");
    });
    const synthesize = vi.fn(() => {
      throw new Error("Experience must not synthesize speech at runtime");
    });
    const transcodeCommentary = vi.fn(() => {
      throw new Error("Experience must not transcode speech at runtime");
    });
    const runtime = createProductRuntime({
      commentaryPipeline: { generate, synthesize },
      createMediaChunks: (bytes) => [bytes],
      cueBytes: Buffer.from("connection-cue"),
      experienceAudioPack: authoredPack(),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      now: () => "2026-07-19T10:00:00.000Z",
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 1,
    });
    const firstSession = runtime.createListeningSession(fixtureId, "ARG")!;
    const secondSession = runtime.createListeningSession(fixtureId, "FRA")!;
    const first = new ListeningClient();
    const second = new ListeningClient();
    runtime.attachListeningClient(firstSession.id, first);
    runtime.attachListeningClient(secondSession.id, second);
    const events: FixtureStreamEvent[] = [];
    runtime.subscribeFixture(fixtureId, (event) => events.push(event));

    const result = runtime.acceptSourceFact(
      canonicalFact(fixtureId, "winning-goal", {
        provenance: "synthetic_txline_shaped",
        sourceEnvelopeId: `${fixtureId}:run:beat:winning-goal`,
      }),
    );
    expect(result.kind).toBe("accepted");
    await runtime.waitForCommentary();

    await vi.waitFor(() => {
      expect(Buffer.concat(first.chunks).toString()).toContain(
        "authored-winning-goal",
      );
      expect(Buffer.concat(second.chunks).toString()).toContain(
        "authored-winning-goal",
      );
    });
    expect(events.at(-1)).toMatchObject({
      commentary: {
        momentIdentity: "winning-goal:1",
        provider: "authored",
        text: "Goal for Argentina! They strike late and lead France two goals to one.",
        usedFallback: false,
      },
      event: "commentary.ready",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(transcodeCommentary).not.toHaveBeenCalled();

    const firstCopy = await runtime.commentaryAudio(
      fixtureId,
      "winning-goal:1",
    );
    expect(firstCopy?.toString()).toBe("authored-winning-goal");
    firstCopy![0] = 0;
    expect(
      (await runtime.commentaryAudio(fixtureId, "winning-goal:1"))?.toString(),
    ).toBe("authored-winning-goal");
    expect((await runtime.memoryIntroAudio(fixtureId))?.toString()).toBe(
      "authored-memory-intro",
    );
    await runtime.close();
  });

  it("resolves restored Experience audio directly from the authored pack", async () => {
    const fixtureId = "experience:authored-restored";
    const fact = canonicalFact(fixtureId, "restored-winning-goal", {
      provenance: "synthetic_txline_shaped",
      sourceEnvelopeId: `${fixtureId}:run:beat:winning-goal`,
    });
    const restored = reduceSourceFact(
      createFixtureProjection({
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        observedAt: fact.receivedAt,
        provenance: "synthetic_txline_shaped",
      }),
      fact,
    );
    const event: FixtureStreamEvent = {
      event: "moment.created",
      id: `${fixtureId}:revision:1`,
      moment: restored.moment!,
      snapshot: toFixtureSnapshot(restored.projection),
    };
    const generate = vi.fn(() => {
      throw new Error("Restored Experience must not invoke runtime AI");
    });
    const runtime = createProductRuntime({
      commentaryPipeline: { generate },
      cueBytes: Buffer.from("connection-cue"),
      experienceAudioPack: authoredPack(),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    runtime.registerFixture(
      {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      { events: [event], projection: restored.projection },
    );

    expect(
      (
        await runtime.commentaryAudio(
          fixtureId,
          "restored-winning-goal:1",
        )
      )?.toString(),
    ).toBe("authored-winning-goal");
    expect(generate).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("fails closed when a fixed Experience beat is absent from the authored pack", async () => {
    const fixtureId = "experience:missing-authored-beat";
    const generate = vi.fn(() => {
      throw new Error("Missing authored beats must not reach runtime AI");
    });
    const synthesize = vi.fn(() => {
      throw new Error("Missing authored beats must not reach runtime TTS");
    });
    const transcodeCommentary = vi.fn(() => {
      throw new Error("Missing authored beats must not reach runtime ffmpeg");
    });
    const runtime = createProductRuntime({
      commentaryPipeline: { generate, synthesize },
      cueBytes: Buffer.from("connection-cue"),
      experienceAudioPack: authoredPack(),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 60_000,
    });
    runtime.subscribeFixture(fixtureId, () => undefined);

    runtime.acceptSourceFact(
      canonicalFact(fixtureId, "unknown-beat", {
        provenance: "synthetic_txline_shaped",
        sourceEnvelopeId: `${fixtureId}:run:beat:unknown-beat`,
      }),
    );
    await runtime.waitForCommentary();

    expect(
      await runtime.commentaryAudio(fixtureId, "unknown-beat:1"),
    ).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(transcodeCommentary).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("never resolves the Experience pack for a live TxLINE moment", async () => {
    const fixtureId = "live:provider-boundary";
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl: vi.fn() });
    const generate = vi.spyOn(pipeline, "generate");
    const pack = authoredPack();
    const forMoment = vi.spyOn(pack, "forMoment").mockReturnValue(
      authoredAsset("winning-goal", "wrong source", "wrong-source"),
    );
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      cueBytes: Buffer.from("connection-cue"),
      experienceAudioPack: pack,
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-19T18:00:00.000Z",
        provenance: "live_txline",
      },
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary: async (bytes) => bytes,
      writeIntervalMs: 60_000,
    });
    runtime.subscribeFixture(fixtureId, () => undefined);

    runtime.acceptSourceFact(canonicalFact(fixtureId, "live-goal", {}));
    await runtime.waitForCommentary();

    expect(generate).toHaveBeenCalledOnce();
    expect(forMoment).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("retains real Experience speech for Match Memory and prepares its spoken intro", async () => {
    const fixtureId = "experience:memory-audio";
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl: vi.fn() });
    const generateArtifact = pipeline.generate.bind(pipeline);
    vi.spyOn(pipeline, "generate").mockImplementation(async (input) => {
      const generated = await generateArtifact(input);
      return {
        ...generated,
        artifact: {
          ...generated.artifact,
          provenance: {
            ...generated.artifact.provenance,
            speechFallbackReason: null,
            speechProvider: "gemini" as const,
          },
        },
      };
    });
    vi.spyOn(pipeline, "synthesize").mockResolvedValue({
      bytes: Buffer.from("intro-wav"),
      fallbackReason: null,
      mimeType: "audio/wav",
      model: "gemini-3.1-flash-tts-preview",
      provider: "gemini",
    });
    const transcodeCommentary = vi.fn(async (bytes: Buffer) =>
      Buffer.from(`mp3:${bytes.toString()}`),
    );
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      createMediaChunks: (bytes) => [bytes],
      cueBytes: Buffer.from("goal-cue"),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 60_000,
    });
    runtime.subscribeFixture(fixtureId, () => undefined);

    expect(
      runtime.acceptSourceFact(
        canonicalFact(fixtureId, "memory-goal", {
          provenance: "synthetic_txline_shaped",
        }),
      ).kind,
    ).toBe("accepted");
    await runtime.waitForCommentary();

    expect(
      (await runtime.commentaryAudio(fixtureId, "memory-goal:1"))?.toString(),
    ).toMatch(/^mp3:/u);
    expect((await runtime.memoryIntroAudio(fixtureId))?.toString()).toBe(
      "mp3:intro-wav",
    );
    expect(pipeline.synthesize).toHaveBeenCalledWith(
      "Here is your MatchSense match summary.",
      "Kore",
    );
    await runtime.close();

    const restoredFact = canonicalFact(fixtureId, "restored-goal", {
      provenance: "synthetic_txline_shaped",
    });
    const restored = reduceSourceFact(
      createFixtureProjection({
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        observedAt: restoredFact.receivedAt,
        provenance: "synthetic_txline_shaped",
      }),
      restoredFact,
    );
    expect(restored.moment).not.toBeNull();
    const restoredEvent: FixtureStreamEvent = {
      event: "moment.created",
      id: `${fixtureId}:revision:1`,
      moment: restored.moment!,
      snapshot: toFixtureSnapshot(restored.projection),
    };
    const recovered = createProductRuntime({
      commentaryPipeline: pipeline,
      cueBytes: Buffer.from("goal-cue"),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 60_000,
    });

    recovered.registerFixture(
      {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      { events: [restoredEvent], projection: restored.projection },
    );
    await recovered.waitForCommentary();

    expect(
      (
        await recovered.commentaryAudio(fixtureId, "restored-goal:1")
      )?.toString(),
    ).toMatch(/^mp3:/u);
    await recovered.close();
  });

  it("retries the Match Memory intro after a transient TTS fallback", async () => {
    const fixtureId = "experience:memory-retry";
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl: vi.fn() });
    vi.spyOn(pipeline, "synthesize")
      .mockResolvedValueOnce({
        bytes: Buffer.from("fallback-wav"),
        fallbackReason: "gemini_http_429",
        mimeType: "audio/wav",
        model: "deterministic-two-tone-v1",
        provider: "deterministic-cue",
      })
      .mockResolvedValueOnce({
        bytes: Buffer.from("recovered-wav"),
        fallbackReason: null,
        mimeType: "audio/wav",
        model: "gemini-3.1-flash-tts-preview",
        provider: "gemini",
      });
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      createMediaChunks: (bytes) => [bytes],
      cueBytes: Buffer.from("goal-cue"),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary: async (bytes) =>
        Buffer.from(`mp3:${bytes.toString()}`),
      writeIntervalMs: 60_000,
    });

    expect(await runtime.memoryIntroAudio(fixtureId)).toBeNull();
    expect((await runtime.memoryIntroAudio(fixtureId))?.toString()).toBe(
      "mp3:recovered-wav",
    );
    expect(pipeline.synthesize).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("retries a saved Moment when its first speech generation falls back", async () => {
    const fixtureId = "experience:moment-retry";
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl: vi.fn() });
    const generateArtifact = pipeline.generate.bind(pipeline);
    let attempts = 0;
    const generate = vi
      .spyOn(pipeline, "generate")
      .mockImplementation(async (input) => {
        const generated = await generateArtifact(input);
        attempts += 1;
        return attempts === 1
          ? generated
          : {
              ...generated,
              artifact: {
                ...generated.artifact,
                provenance: {
                  ...generated.artifact.provenance,
                  speechFallbackReason: null,
                  speechProvider: "gemini" as const,
                },
              },
            };
      });
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      createMediaChunks: (bytes) => [bytes],
      cueBytes: Buffer.from("goal-cue"),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary: async (bytes) =>
        Buffer.from(`mp3:${bytes.toString("hex")}`),
      writeIntervalMs: 60_000,
    });
    runtime.subscribeFixture(fixtureId, () => undefined);
    runtime.acceptSourceFact(
      canonicalFact(fixtureId, "retry-goal", {
        provenance: "synthetic_txline_shaped",
      }),
    );
    await runtime.waitForCommentary();

    expect(
      (await runtime.commentaryAudio(fixtureId, "retry-goal:1"))?.toString(),
    ).toMatch(/^mp3:/u);
    expect(generate).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("prepares once, fans one generated call to every listener, and publishes its transcript", async () => {
    const pipeline = createCommentaryPipeline({
      env: {},
      fetchImpl: vi.fn(),
      now: () => new Date("2026-07-16T12:00:03.000Z"),
    });
    const generateArtifact = pipeline.generate.bind(pipeline);
    const generate = vi
      .spyOn(pipeline, "generate")
      .mockImplementation(async (input) => {
        const generated = await generateArtifact(input);
        return {
          ...generated,
          artifact: {
            ...generated.artifact,
            provenance: {
              ...generated.artifact.provenance,
              speechFallbackReason: null,
              speechProvider: "gemini" as const,
            },
          },
        };
      });
    const transcodeCommentary = vi
      .fn<(wav: Buffer) => Promise<Buffer>>()
      .mockResolvedValue(Buffer.from("shared-voice"));
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      createMediaChunks: (bytes) => [bytes],
      cueBytes: Buffer.from("goal-cue"),
      now: () => "2026-07-16T12:00:00.000Z",
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 1,
    });
    const argListener = runtime.createListeningSession("arg-fra-demo", "ARG");
    const fraListener = runtime.createListeningSession("arg-fra-demo", "FRA");
    expect(argListener).not.toBeNull();
    expect(fraListener).not.toBeNull();
    const first = new ListeningClient();
    const second = new ListeningClient();
    runtime.attachListeningClient(argListener!.id, first);
    runtime.attachListeningClient(fraListener!.id, second);
    const events: FixtureStreamEvent[] = [];
    runtime.subscribeFixture("arg-fra-demo", (event) => events.push(event));

    await runtime.waitForCommentary();
    expect(generate).toHaveBeenCalledOnce();
    expect(transcodeCommentary).toHaveBeenCalledOnce();

    const replay = runtime.createReplaySession("arg-fra-demo");
    runtime.commandReplay(replay.id, {
      listeningSessionId: argListener!.id,
      marker: "goal",
      type: "advance_to_marker",
    });
    await runtime.waitForCommentary();

    expect(generate).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(Buffer.concat(first.chunks).toString()).toContain("shared-voice"),
    );
    expect(Buffer.concat(second.chunks).toString()).toContain("shared-voice");
    expect(events.at(-1)).toMatchObject({
      commentary: {
        language: "en",
        momentIdentity: "arg-fra-demo:event:synthetic-goal-arg-fra-1:1",
        provider: "gemini",
        text: expect.stringContaining("Argentina lead France 1–0"),
      },
      event: "commentary.ready",
    });
    runtime.close();
  });

  it("streams red-card, VAR, and full-time speech to an active live listener", async () => {
    const fixtureId = "experience-radio";
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl: vi.fn() });
    const generate = vi.spyOn(pipeline, "generate");
    const transcodeCommentary = vi
      .fn<(wav: Buffer) => Promise<Buffer>>()
      .mockResolvedValue(Buffer.from("radio-voice"));
    const notifyMoment = vi.fn();
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      createMediaChunks: (bytes) => [bytes],
      cueBytes: Buffer.from("goal-cue"),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "live_txline",
      },
      notifyMoment,
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 1,
    });
    const session = runtime.createListeningSession(fixtureId, "ARG");
    expect(session).not.toBeNull();
    const listener = new ListeningClient();
    runtime.attachListeningClient(session!.id, listener);
    const stream: FixtureStreamEvent[] = [];
    runtime.subscribeFixture(fixtureId, (event) => stream.push(event));

    for (const fact of [
      canonicalFact(fixtureId, "kickoff", {
        kind: "phase.kickoff",
        minute: "0'",
        team: null,
      }),
      canonicalFact(fixtureId, "red-france", {
        kind: "card.red",
        minute: "18'",
        team: "FRA",
      }),
      canonicalFact(fixtureId, "goal-arg", {}),
      canonicalFact(fixtureId, "var-started-goal-arg", {
        familyId: "goal-arg",
        kind: "var.started",
        status: "under_review",
        targetFamilyId: "goal-arg",
        team: null,
      }),
      canonicalFact(fixtureId, "var-stands-goal-arg", {
        familyId: "goal-arg",
        kind: "var.stands",
        targetFamilyId: "goal-arg",
        team: null,
      }),
      canonicalFact(fixtureId, "half-time", {
        kind: "phase.half_time",
        minute: "45'",
        team: null,
      }),
      canonicalFact(fixtureId, "second-half", {
        kind: "phase.second_half_start",
        minute: "46'",
        team: null,
      }),
      canonicalFact(fixtureId, "full-time", {
        kind: "phase.full_time",
        minute: "90'",
        team: null,
      }),
    ]) {
      expect(runtime.acceptSourceFact(fact).kind).toBe("accepted");
    }
    await runtime.waitForCommentary();

    const narratedKinds = generate.mock.calls.map(
      ([input]) => input.event.kind,
    );
    expect(narratedKinds).toEqual([
      "phase.kickoff",
      "card.red",
      "goal",
      "var.started",
      "var.stands",
      "phase.half_time",
      "phase.second_half_start",
      "phase.full_time",
    ]);
    expect(transcodeCommentary).toHaveBeenCalledTimes(narratedKinds.length);
    await vi.waitFor(() =>
      expect(Buffer.concat(listener.chunks).toString()).toContain(
        "radio-voice",
      ),
    );
    expect(
      stream
        .filter((event) => event.event === "commentary.ready")
        .map((event) => event.commentary?.text),
    ).toEqual(
      expect.arrayContaining([
        "Red card for France in the 18th minute.",
        "VAR review underway for Argentina. The decision is being checked. Celebration held.",
        "Full-time. Argentina 1–0 France.",
      ]),
    );
    expect(notifyMoment).toHaveBeenCalledTimes(2);
    runtime.close();
  });

  it("serializes speech generation and delivery in canonical order", async () => {
    const fixtureId = "ordered-radio";
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl: vi.fn() });
    const generateArtifact = pipeline.generate.bind(pipeline);
    let releaseRedCard: (() => void) | undefined;
    const redCardGate = new Promise<void>((resolve) => {
      releaseRedCard = resolve;
    });
    const generate = vi
      .spyOn(pipeline, "generate")
      .mockImplementation(async (input) => {
        if (input.event.kind === "card.red") await redCardGate;
        const result = await generateArtifact(input);
        return {
          ...result,
          artifact: {
            ...result.artifact,
            audio: {
              ...result.artifact.audio,
              bytes: Buffer.from(`[${input.event.kind}]`),
            },
          },
        };
      });
    const transcodeCommentary = vi.fn(async (bytes: Buffer) => bytes);
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      createMediaChunks: (bytes) => [bytes],
      cueBytes: Buffer.from("goal-cue"),
      fixture: {
        awayTeam: "FRA",
        fixtureId,
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "live_txline",
      },
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 1,
    });
    const session = runtime.createListeningSession(fixtureId, "ARG")!;
    const listener = new ListeningClient();
    runtime.attachListeningClient(session.id, listener);

    runtime.acceptSourceFact(
      canonicalFact(fixtureId, "red-first", {
        kind: "card.red",
        team: "FRA",
      }),
    );
    runtime.acceptSourceFact(
      canonicalFact(fixtureId, "corner-second", {
        kind: "corner",
        minute: "24'",
      }),
    );
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[0].event.kind).toBe("card.red");
    expect(transcodeCommentary).not.toHaveBeenCalled();
    releaseRedCard?.();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await runtime.waitForCommentary();

    await vi.waitFor(() =>
      expect(Buffer.concat(listener.chunks).toString()).toContain("[corner]"),
    );
    const delivered = Buffer.concat(listener.chunks).toString();
    expect(delivered.indexOf("[card.red]")).toBeGreaterThanOrEqual(0);
    expect(delivered.indexOf("[corner]")).toBeGreaterThan(
      delivered.indexOf("[card.red]"),
    );
    runtime.close();
  });
});
