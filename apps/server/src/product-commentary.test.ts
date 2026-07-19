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
      runtime.commentaryAudio(fixtureId, "memory-goal:1")?.toString(),
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
      recovered.commentaryAudio(fixtureId, "restored-goal:1")?.toString(),
    ).toMatch(/^mp3:/u);
    await recovered.close();
  });

  it("prepares once, fans one generated call to every listener, and publishes its transcript", async () => {
    const pipeline = createCommentaryPipeline({
      env: {},
      fetchImpl: vi.fn(),
      now: () => new Date("2026-07-16T12:00:03.000Z"),
    });
    const generate = vi.spyOn(pipeline, "generate");
    const transcodeCommentary = vi
      .fn<(wav: Buffer) => Promise<Buffer>>()
      .mockResolvedValue(Buffer.from("shared-voice"));
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      cueBytes: Buffer.from("goal-cue"),
      now: () => "2026-07-16T12:00:00.000Z",
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 60_000,
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
    expect(Buffer.concat(first.chunks).toString()).toContain("shared-voice");
    expect(Buffer.concat(second.chunks).toString()).toContain("shared-voice");
    expect(events.at(-1)).toMatchObject({
      commentary: {
        language: "en",
        momentIdentity: "arg-fra-demo:event:synthetic-goal-arg-fra-1:1",
        provider: "deterministic",
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
      writeIntervalMs: 60_000,
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
    expect(Buffer.concat(listener.chunks).toString()).toContain("radio-voice");
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

  it("delivers generated speech in canonical order even when a later synthesis finishes first", async () => {
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
      writeIntervalMs: 60_000,
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
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(transcodeCommentary).toHaveBeenCalledOnce());
    releaseRedCard?.();
    await runtime.waitForCommentary();

    const delivered = Buffer.concat(listener.chunks).toString();
    expect(delivered.indexOf("[card.red]")).toBeGreaterThanOrEqual(0);
    expect(delivered.indexOf("[corner]")).toBeGreaterThan(
      delivered.indexOf("[card.red]"),
    );
    runtime.close();
  });
});
