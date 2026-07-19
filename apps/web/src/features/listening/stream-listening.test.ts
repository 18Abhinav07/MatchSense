import { describe, expect, it, vi } from "vitest";

import {
  createStreamListeningController,
  type StreamAudioElement,
} from "./stream-listening.js";

function audioFixture() {
  const listeners = new Map<string, Set<() => void>>();
  let source: string | null = null;
  const audio: StreamAudioElement = {
    addEventListener: (event, listener) => {
      const group = listeners.get(event) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(event, group);
    },
    getAttribute: (name) => (name === "src" ? source : null),
    load: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    removeAttribute: vi.fn((name) => {
      if (name === "src") source = null;
    }),
    removeEventListener: (event, listener) =>
      listeners.get(event)?.delete(listener),
    setAttribute: vi.fn((name, value) => {
      if (name === "src") source = value;
    }),
  };
  return {
    audio,
    emit(event: "ended" | "error" | "pause" | "playing" | "waiting") {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

const input = { fixtureId: "experience:run-1", perspectiveTeam: "ARG" };

describe("continuous Pocket Listening controller", () => {
  it("starts the prepared stream from the fan gesture without reloading it", async () => {
    const { audio, emit } = audioFixture();
    const api = {
      create: vi.fn(async () => ({ id: "listen-1" })),
      remove: vi.fn(async () => undefined),
      streamUrl: (id: string) => `/api/v1/listening-sessions/${id}/stream.mp3`,
    };
    const controller = createStreamListeningController({ api, audio });

    await controller.prepare(input);

    expect(api.create).toHaveBeenCalledOnce();
    expect(audio.setAttribute).toHaveBeenCalledWith(
      "src",
      "/api/v1/listening-sessions/listen-1/stream.mp3",
    );
    expect(audio.play).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      prepared: true,
      state: "stopped",
    });

    const started = controller.startFromGesture();
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(controller.snapshot().state).toBe("connecting");
    emit("playing");
    await started;
    expect(controller.snapshot().state).toBe("listening");
  });

  it("keeps canonical captions without fetching or restarting media", async () => {
    const { audio, emit } = audioFixture();
    const api = {
      create: vi.fn(async () => ({ id: "listen-1" })),
      remove: vi.fn(async () => undefined),
      streamUrl: (id: string) => `/stream/${id}`,
    };
    const controller = createStreamListeningController({ api, audio });
    await controller.prepare(input);
    const started = controller.startFromGesture();
    emit("playing");
    await started;
    vi.mocked(audio.load).mockClear();
    vi.mocked(audio.play).mockClear();
    vi.mocked(audio.setAttribute).mockClear();

    controller.announce({
      familyId: "goal-1",
      fixtureId: input.fixtureId,
      revision: 2,
      text: "Argentina take the lead.",
    });

    expect(controller.snapshot()).toMatchObject({
      lastCueText: "Argentina take the lead.",
      state: "listening",
    });
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.setAttribute).not.toHaveBeenCalled();
  });

  it("reloads the unchanged stream at the live edge after pause", async () => {
    const { audio, emit } = audioFixture();
    const api = {
      create: vi.fn(async () => ({ id: "listen-1" })),
      remove: vi.fn(async () => undefined),
      streamUrl: (id: string) => `/stream/${id}`,
    };
    const controller = createStreamListeningController({ api, audio });
    await controller.prepare(input);
    const started = controller.startFromGesture();
    emit("playing");
    await started;
    vi.mocked(audio.load).mockClear();
    vi.mocked(audio.setAttribute).mockClear();

    controller.pause();
    expect(controller.snapshot().state).toBe("paused");
    const resumed = controller.resumeFromGesture();

    expect(api.create).toHaveBeenCalledOnce();
    expect(audio.setAttribute).not.toHaveBeenCalled();
    expect(audio.load).toHaveBeenCalledOnce();
    expect(controller.snapshot().state).toBe("connecting");
    emit("playing");
    await resumed;
    expect(controller.snapshot().state).toBe("listening");
  });

  it("deletes the listening session on terminal Stop", async () => {
    const { audio } = audioFixture();
    const api = {
      create: vi.fn(async () => ({ id: "listen-1" })),
      remove: vi.fn(async () => undefined),
      streamUrl: (id: string) => `/stream/${id}`,
    };
    const controller = createStreamListeningController({ api, audio });
    await controller.prepare(input);

    await controller.stop();

    expect(api.remove).toHaveBeenCalledWith("listen-1");
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      prepared: false,
      state: "stopped",
    });
  });

  it("can prepare a fresh session after terminal Stop", async () => {
    const { audio } = audioFixture();
    const api = {
      create: vi
        .fn()
        .mockResolvedValueOnce({ id: "listen-1" })
        .mockResolvedValueOnce({ id: "listen-2" }),
      remove: vi.fn(async () => undefined),
      streamUrl: (id: string) => `/stream/${id}`,
    };
    const controller = createStreamListeningController({ api, audio });
    await controller.prepare(input);
    await controller.stop();
    await controller.prepare(input);

    expect(api.create).toHaveBeenCalledTimes(2);
    expect(audio.setAttribute).toHaveBeenLastCalledWith(
      "src",
      "/stream/listen-2",
    );
    expect(controller.snapshot()).toMatchObject({
      prepared: true,
      state: "stopped",
    });
  });

  it("automatically rejoins the live edge after a locked-device stream error", async () => {
    const { audio, emit } = audioFixture();
    const scheduled: Array<() => void> = [];
    const clearSchedule = vi.fn();
    const schedule = vi.fn((callback: () => void) => {
      scheduled.push(callback);
      return 17 as unknown as ReturnType<typeof setTimeout>;
    });
    const controller = createStreamListeningController({
      api: {
        create: vi.fn(async () => ({ id: "listen-1" })),
        remove: vi.fn(async () => undefined),
        streamUrl: (id: string) => `/stream/${id}`,
      },
      audio,
      clearSchedule,
      schedule,
    });
    await controller.prepare(input);
    const started = controller.startFromGesture();
    emit("playing");
    await started;
    vi.mocked(audio.load).mockClear();
    vi.mocked(audio.play).mockClear();

    emit("error");

    expect(controller.snapshot().state).toBe("connecting");
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1_500);
    scheduled[0]!();
    expect(audio.load).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();
    emit("playing");
    expect(controller.snapshot().state).toBe("listening");
    expect(clearSchedule).not.toHaveBeenCalled();
  });

  it("automatically rejoins the live edge when iOS reports ended", async () => {
      const { audio, emit } = audioFixture();
      const scheduled: Array<() => void> = [];
      const schedule = vi.fn((callback: () => void) => {
        scheduled.push(callback);
        return 19 as unknown as ReturnType<typeof setTimeout>;
      });
      const controller = createStreamListeningController({
        api: {
          create: vi.fn(async () => ({ id: "listen-1" })),
          remove: vi.fn(async () => undefined),
          streamUrl: (id: string) => `/stream/${id}`,
        },
        audio,
        schedule,
      });
      await controller.prepare(input);
      const started = controller.startFromGesture();
      emit("playing");
      await started;
      vi.mocked(audio.load).mockClear();
      vi.mocked(audio.play).mockClear();

      emit("ended");

      expect(controller.snapshot().state).toBe("connecting");
      expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1_500);
      scheduled[0]!();
      expect(audio.load).toHaveBeenCalledOnce();
      expect(audio.play).toHaveBeenCalledOnce();
  });

  it("does not reload during normal iOS startup buffering", async () => {
    const { audio, emit } = audioFixture();
    const schedule = vi.fn();
    const controller = createStreamListeningController({
      api: {
        create: vi.fn(async () => ({ id: "listen-1" })),
        remove: vi.fn(async () => undefined),
        streamUrl: (id: string) => `/stream/${id}`,
      },
      audio,
      schedule,
    });
    await controller.prepare(input);

    const started = controller.startFromGesture();
    emit("waiting");
    await started;

    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(controller.snapshot().state).toBe("connecting");
    emit("playing");
    expect(controller.snapshot().state).toBe("listening");
  });
});
