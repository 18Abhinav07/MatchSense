import { describe, expect, it, vi } from "vitest";

import {
  createCommentaryCacheKey,
  createMemoryCommentaryArtifactStore,
  createCommentaryPipeline,
  type CommentaryInput,
} from "./index.js";

const baseInput: CommentaryInput = {
  event: {
    awayTeam: { id: "FRA", name: "France" },
    eventTeamId: "ARG",
    fixtureId: "arg-fra-demo",
    homeTeam: { id: "ARG", name: "Argentina" },
    kind: "goal",
    minute: "23'",
    momentId: "arg-fra-demo:score:1-0",
    playerDisplayName: null,
    revision: 1,
    score: { away: 0, home: 1 },
    status: "confirmed",
  },
  fan: {
    eventMode: "live",
    language: "en",
    locale: "en-IN",
    perspectiveTeamId: "ARG",
    voice: { name: "Kore", revision: "gemini-kore-v1" },
  },
};

function successfulProviderFetch(options?: {
  colorPhrase?: string;
  mimeType?: string;
  pcm?: Buffer;
}) {
  const pcm = options?.pcm ?? Buffer.from([0, 0, 255, 127]);
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.groq.com")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  colorPhrase:
                    options?.colorPhrase ?? "The stadium finds its voice.",
                  delivery: "celebratory",
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      data: pcm.toString("base64"),
                      mimeType:
                        options?.mimeType ??
                        "audio/L16; rate=24000; channels=1",
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

describe("shared commentary pipeline", () => {
  it("shares one production cache identity across team perspectives", () => {
    const first = createCommentaryCacheKey(baseInput);

    expect(first).toBe("arg-fra-demo:score:1-0:1|en|en-IN|live|gemini-kore-v1");
    expect(
      createCommentaryCacheKey({
        ...baseInput,
        fan: { ...baseInput.fan, perspectiveTeamId: "BRA" },
      }),
    ).toBe(first);
    expect(
      createCommentaryCacheKey({
        ...baseInput,
        event: { ...baseInput.event, revision: 2 },
      }),
    ).not.toBe(first);
  });

  it("keeps facts deterministic while reusing the proven Groq and Gemini contracts", async () => {
    const fetchImpl = successfulProviderFetch();
    const pipeline = createCommentaryPipeline({
      env: {
        GEMINI_API_KEY: "gemini-test-key",
        GROQ_API_KEY: "groq-test-key",
      },
      fetchImpl,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });

    const result = await pipeline.generate(baseInput);

    expect(result.cache).toBe("generated");
    expect(result.artifact.transcript).toBe(
      "Goal! Argentina score. Argentina lead France 1–0 in the 23rd minute. The stadium finds its voice.",
    );
    expect(result.artifact.audio.mimeType).toBe("audio/wav");
    expect(result.artifact.audio.bytes.subarray(0, 4).toString("ascii")).toBe(
      "RIFF",
    );
    expect(result.artifact.audio.path).toBe(
      `/api/v1/commentary/${result.artifact.commentaryId}/audio`,
    );
    expect(result.artifact.provenance).toMatchObject({
      atmosphereFallbackReason: null,
      atmosphereModel: "openai/gpt-oss-20b",
      speechFallbackReason: null,
      speechModel: "gemini-3.1-flash-tts-preview",
      speechProvider: "gemini",
    });

    const groqCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes("api.groq.com"),
    );
    const geminiCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes("generativelanguage.googleapis.com"),
    );
    expect(groqCall).toBeDefined();
    expect(geminiCall).toBeDefined();
    const groqBody = JSON.parse(
      String((groqCall?.[1] as RequestInit | undefined)?.body),
    );
    expect(groqBody.model).toBe("openai/gpt-oss-20b");
    expect(groqBody.response_format.json_schema.strict).toBe(true);
    const geminiBody = JSON.parse(
      String((geminiCall?.[1] as RequestInit | undefined)?.body),
    );
    expect(geminiBody.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(
      geminiBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
        .voiceName,
    ).toBe("Kore");
  });

  it("deduplicates concurrent work and serves later listeners from one cached artifact", async () => {
    let releaseGroq: (() => void) | undefined;
    const groqGate = new Promise<void>((resolve) => {
      releaseGroq = resolve;
    });
    const providerFetch = successfulProviderFetch();
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("api.groq.com")) await groqGate;
        return providerFetch(input, init);
      },
    );
    const pipeline = createCommentaryPipeline({
      env: {
        GEMINI_API_KEY: "gemini-test-key",
        GROQ_API_KEY: "groq-test-key",
      },
      fetchImpl,
    });

    const firstPromise = pipeline.generate(baseInput);
    const secondPromise = pipeline.generate({
      ...baseInput,
      fan: { ...baseInput.fan, perspectiveTeamId: "BRA" },
    });
    releaseGroq?.();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const third = await pipeline.generate(baseInput);

    expect(first.cache).toBe("generated");
    expect(second.cache).toBe("inflight");
    expect(third.cache).toBe("hit");
    expect(second.artifact.commentaryId).toBe(first.artifact.commentaryId);
    expect(third.artifact.commentaryId).toBe(first.artifact.commentaryId);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pipeline.status()).toEqual({ cached: 1, inflight: 0 });
  });

  it("deduplicates generation across pipeline instances sharing one store", async () => {
    let releaseGroq: (() => void) | undefined;
    const groqGate = new Promise<void>((resolve) => {
      releaseGroq = resolve;
    });
    const providerFetch = successfulProviderFetch();
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("api.groq.com")) await groqGate;
        return providerFetch(input, init);
      },
    );
    const store = createMemoryCommentaryArtifactStore();
    const options = {
      env: {
        GEMINI_API_KEY: "gemini-test-key",
        GROQ_API_KEY: "groq-test-key",
      },
      fetchImpl,
      store,
    } as const;
    const firstPipeline = createCommentaryPipeline(options);
    const secondPipeline = createCommentaryPipeline(options);

    const firstPromise = firstPipeline.generate(baseInput);
    const secondPromise = secondPipeline.generate({
      ...baseInput,
      fan: { ...baseInput.fan, perspectiveTeamId: "BRA" },
    });
    releaseGroq?.();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.cache).toBe("generated");
    expect(second.cache).toBe("inflight");
    expect(second.artifact.commentaryId).toBe(first.artifact.commentaryId);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses deterministic commentary and a playable deterministic cue when keys are absent", async () => {
    const fetchImpl = vi.fn();
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl });

    const first = await pipeline.generate(baseInput);
    const independentPipeline = createCommentaryPipeline({
      env: {},
      fetchImpl,
    });
    const second = await independentPipeline.generate(baseInput);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(first.artifact.transcript).toBe(
      "Goal! Argentina score. Argentina lead France 1–0 in the 23rd minute. What a moment.",
    );
    expect(first.artifact.audio.bytes.subarray(0, 4).toString("ascii")).toBe(
      "RIFF",
    );
    expect(first.artifact.audio.sha256).toBe(second.artifact.audio.sha256);
    expect(first.artifact.provenance).toMatchObject({
      atmosphereFallbackReason: "groq_missing_key",
      atmosphereModel: "deterministic-fallback",
      speechFallbackReason: "gemini_missing_key",
      speechModel: "deterministic-two-tone-v1",
      speechProvider: "deterministic-cue",
    });
  });

  it("fails closed on provider quota without losing the factual call", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("api.groq.com")) {
        return new Response("quota", { status: 429 });
      }
      return new Response("quota", { status: 429 });
    });
    const pipeline = createCommentaryPipeline({
      env: {
        GEMINI_API_KEY: "gemini-secret-value",
        GROQ_API_KEY: "groq-secret-value",
      },
      fetchImpl,
    });

    const result = await pipeline.generate(baseInput);
    const serialized = JSON.stringify(result.artifact);

    expect(result.artifact.transcript).toContain("Argentina lead France 1–0");
    expect(result.artifact.provenance).toMatchObject({
      atmosphereFallbackReason: "groq_http_429",
      speechFallbackReason: "gemini_http_429",
      speechProvider: "deterministic-cue",
    });
    expect(serialized).not.toContain("groq-secret-value");
    expect(serialized).not.toContain("gemini-secret-value");
    expect(serialized).not.toContain("quota");
  });

  it("rejects atmospheric output that tries to add unverified facts", async () => {
    const fetchImpl = successfulProviderFetch({
      colorPhrase: "A Messi header flies into the top corner.",
    });
    const pipeline = createCommentaryPipeline({
      env: {
        GEMINI_API_KEY: "gemini-test-key",
        GROQ_API_KEY: "groq-test-key",
      },
      fetchImpl,
    });

    const result = await pipeline.generate(baseInput);

    expect(result.artifact.transcript).toMatch(/What a moment\.$/);
    expect(result.artifact.transcript).not.toMatch(/Messi|header|top corner/i);
    expect(result.artifact.provenance.atmosphereFallbackReason).toBe(
      "groq_unsafe_color",
    );
  });

  it("rejects score claims written with words instead of digits", async () => {
    const fetchImpl = successfulProviderFetch({
      colorPhrase: "They make it two nil and take the lead.",
    });
    const pipeline = createCommentaryPipeline({
      env: {
        GEMINI_API_KEY: "gemini-test-key",
        GROQ_API_KEY: "groq-test-key",
      },
      fetchImpl,
    });

    const result = await pipeline.generate(baseInput);

    expect(result.artifact.transcript).toMatch(/What a moment\.$/);
    expect(result.artifact.transcript).not.toMatch(/two nil|take the lead/i);
    expect(result.artifact.provenance.atmosphereFallbackReason).toBe(
      "groq_unsafe_color",
    );
  });

  it("rejects non-allowlisted shot prose even when it contains no names or score", async () => {
    const fetchImpl = successfulProviderFetch({
      colorPhrase: "A volley flashes beyond the defence.",
    });
    const pipeline = createCommentaryPipeline({
      env: {
        GEMINI_API_KEY: "gemini-test-key",
        GROQ_API_KEY: "groq-test-key",
      },
      fetchImpl,
    });

    const result = await pipeline.generate(baseInput);

    expect(result.artifact.transcript).toMatch(/What a moment\.$/);
    expect(result.artifact.transcript).not.toMatch(/volley|defence/i);
    expect(result.artifact.provenance.atmosphereFallbackReason).toBe(
      "groq_unsafe_color",
    );
  });

  it("falls back instead of wrapping non-PCM Gemini data as WAV", async () => {
    const fetchImpl = successfulProviderFetch({
      mimeType: "audio/mpeg",
      pcm: Buffer.from("not-pcm-audio", "utf8"),
    });
    const pipeline = createCommentaryPipeline({
      env: {
        GEMINI_API_KEY: "gemini-test-key",
        GROQ_API_KEY: "groq-test-key",
      },
      fetchImpl,
    });

    const result = await pipeline.generate(baseInput);

    expect(result.artifact.provenance).toMatchObject({
      speechFallbackReason: "gemini_unsupported_audio",
      speechProvider: "deterministic-cue",
    });
    expect(result.artifact.audio.bytes.subarray(0, 4).toString("ascii")).toBe(
      "RIFF",
    );
  });

  it("preserves stoppage time instead of truncating 90+3 to the 90th minute", async () => {
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl: vi.fn() });

    const result = await pipeline.generate({
      ...baseInput,
      event: { ...baseInput.event, minute: "90+3'" },
    });

    expect(result.artifact.transcript).toContain(
      "in stoppage time at 90 plus 3",
    );
    expect(result.artifact.transcript).not.toContain("in the 90th minute");
  });

  it("provides an honest Hindi deterministic fallback for a Hindi listener", async () => {
    const pipeline = createCommentaryPipeline({ env: {}, fetchImpl: vi.fn() });

    const result = await pipeline.generate({
      ...baseInput,
      fan: {
        ...baseInput.fan,
        language: "hi",
        locale: "hi-IN",
      },
    });

    expect(result.artifact.transcript).toBe(
      "गोल! अर्जेंटीना ने गोल किया। 23वें मिनट में अर्जेंटीना फ्रांस से 1–0 आगे है। क्या शानदार पल है।",
    );
    expect(result.artifact.provenance.atmosphereFallbackReason).toBe(
      "groq_language_fallback",
    );
  });
});
