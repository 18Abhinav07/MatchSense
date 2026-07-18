import { describe, expect, it, vi } from "vitest";

import {
  createArtifactListeningController,
  type ArtifactAudioElement,
} from "./ListeningProvider.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function audioFixture(options: { play?: () => Promise<void> } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const audio: ArtifactAudioElement = {
    addEventListener: (event, listener) => {
      const group = listeners.get(event) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(event, group);
    },
    load: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(options.play ?? (async () => undefined)),
    removeAttribute: vi.fn(),
    removeEventListener: (event, listener) =>
      listeners.get(event)?.delete(listener),
    setAttribute: vi.fn(),
  };
  return {
    audio,
    emit(event: "ended" | "error") {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

const moment = {
  familyId: "match:goal-1",
  fixtureId: "arg-fra",
  revision: 2,
  text: "Argentina score.",
};

describe("artifact listening controller", () => {
  it("does not fetch or cue an update until the fan has explicitly started Listening Mode", async () => {
    const { audio } = audioFixture();
    const cue = vi.fn();
    const fetcher = vi.fn();
    const controller = createArtifactListeningController({
      activateAudio: vi.fn(async () => undefined),
      audio,
      cue,
      createObjectUrl: () => "blob:goal-1",
      fetcher,
      revokeObjectUrl: vi.fn(),
    });

    await controller.announce(moment);

    expect(cue).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("cues immediately and marks speech only after the canonical artifact has played", async () => {
    const playback = deferred<void>();
    const { audio, emit } = audioFixture({ play: () => playback.promise });
    const events: string[] = [];
    const fetcher = vi.fn(
      async () =>
        new Response(new Blob(["mp3"], { type: "audio/mpeg" }), {
          status: 200,
        }),
    );
    const controller = createArtifactListeningController({
      activateAudio: vi.fn(async () => {
        events.push("activate");
      }),
      audio,
      cue: vi.fn(() => events.push("cue")),
      createObjectUrl: () => "blob:goal-1",
      fetcher,
      revokeObjectUrl: vi.fn(),
    });

    await controller.startFromGesture();
    const delivery = controller.announce(moment);

    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    expect(events).toEqual(["activate", "cue"]);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/fixtures/arg-fra/moments/match%3Agoal-1%3A2/audio",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(controller.snapshot().state).not.toBe("speaking");

    playback.resolve();
    await delivery;
    expect(controller.snapshot()).toMatchObject({
      lastCueText: "Argentina score.",
      state: "speaking",
    });

    emit("ended");
    expect(controller.snapshot().state).toBe("listening");
  });

  it("retries a 404 artifact without claiming that commentary is speaking", async () => {
    const { audio } = audioFixture();
    const schedule = vi.fn(
      () => 11 as unknown as ReturnType<typeof setTimeout>,
    );
    const controller = createArtifactListeningController({
      activateAudio: vi.fn(async () => undefined),
      audio,
      cue: vi.fn(),
      createObjectUrl: () => "blob:goal-1",
      fetcher: vi.fn(async () => new Response(null, { status: 404 })),
      revokeObjectUrl: vi.fn(),
      schedule,
    });

    await controller.startFromGesture();
    await controller.announce(moment);

    expect(audio.play).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      commentaryPending: true,
      state: "reconnecting",
    });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 3_000);
  });

  it("reports Audio blocked when browser playback rejects instead of faking speech", async () => {
    const { audio } = audioFixture({
      play: async () => Promise.reject(new Error("gesture required")),
    });
    const controller = createArtifactListeningController({
      activateAudio: vi.fn(async () => undefined),
      audio,
      cue: vi.fn(),
      createObjectUrl: () => "blob:goal-1",
      fetcher: vi.fn(
        async () =>
          new Response(new Blob(["mp3"], { type: "audio/mpeg" }), {
            status: 200,
          }),
      ),
      revokeObjectUrl: vi.fn(),
    });

    await controller.startFromGesture();
    await controller.announce(moment);

    expect(controller.snapshot().state).toBe("blocked");
  });

  it("supersedes an older unstarted revision before it can speak", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const { audio } = audioFixture();
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controller = createArtifactListeningController({
      activateAudio: vi.fn(async () => undefined),
      audio,
      cue: vi.fn(),
      createObjectUrl: () => "blob:goal-1",
      fetcher,
      revokeObjectUrl: vi.fn(),
    });
    await controller.startFromGesture();

    const stale = controller.announce(moment);
    const current = controller.announce({ ...moment, revision: 3 });
    second.resolve(
      new Response(new Blob(["new"], { type: "audio/mpeg" }), {
        status: 200,
      }),
    );
    await current;
    first.resolve(
      new Response(new Blob(["old"], { type: "audio/mpeg" }), {
        status: 200,
      }),
    );
    await stale;

    expect(audio.play).toHaveBeenCalledOnce();
    expect(controller.snapshot().state).toBe("speaking");
  });
});
