import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ByteCommandRunner } from "./audio-transcoder.js";
import {
  EXPERIENCE_AUDIO_GENERATION_TARGETS,
  createDockerFfmpegRunner,
  createGeminiExperienceWavRequester,
  createMacosExperienceWavRequester,
  generateExperienceAudioPack,
  parseExperienceAudioGeneratorArgs,
  validateExperienceAudioGenerationTargets,
} from "./experience-audio-generation.js";
import {
  EXPERIENCE_AUDIO_SCRIPT,
  EXPERIENCE_MEMORY_INTRO,
} from "./experience-audio-script.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryOutputDirectory() {
  const { mkdtemp } = await import("node:fs/promises");
  const parent = await mkdtemp(path.join(tmpdir(), "matchsense-audio-test-"));
  createdDirectories.push(parent);
  return path.join(parent, "pack");
}

function wavBytes() {
  return Buffer.from("RIFF\u0004\u0000\u0000\u0000WAVEfmt ", "binary");
}

function successfulFetch() {
  return vi.fn(
    async (_input: string | URL, _init?: RequestInit) =>
      new Response(wavBytes(), {
        headers: { "content-type": "audio/wav" },
        status: 200,
      }),
  );
}

async function compatibleMp3() {
  return readFile(new URL("../assets/goal-cue.mp3", import.meta.url));
}

describe("Experience audio generation plan", () => {
  it("covers every authored beat exactly once plus the Memory introduction", () => {
    expect(() =>
      validateExperienceAudioGenerationTargets(
        EXPERIENCE_AUDIO_GENERATION_TARGETS,
      ),
    ).not.toThrow();

    const beatTargets = EXPERIENCE_AUDIO_GENERATION_TARGETS.filter(
      (target) => target.kind !== "memory.intro",
    );
    const memoryTargets = EXPERIENCE_AUDIO_GENERATION_TARGETS.filter(
      (target) => target.kind === "memory.intro",
    );

    expect(beatTargets.map((target) => target.beatKey).sort()).toEqual(
      Object.keys(EXPERIENCE_AUDIO_SCRIPT).sort(),
    );
    expect(memoryTargets).toEqual([
      expect.objectContaining({
        beatKey: "memory-intro",
        file: "memory-intro.mp3",
        transcript: EXPERIENCE_MEMORY_INTRO,
      }),
    ]);
  });

  it("rejects duplicate and partial generation plans before any provider call", () => {
    const [first, second, ...rest] = EXPERIENCE_AUDIO_GENERATION_TARGETS;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    expect(() =>
      validateExperienceAudioGenerationTargets([first, first, ...rest]),
    ).toThrow(/duplicate beat key/i);
    expect(() =>
      validateExperienceAudioGenerationTargets([
        { ...first, file: second.file },
        second,
        ...rest,
      ]),
    ).toThrow(/duplicate output file/i);
    expect(() =>
      validateExperienceAudioGenerationTargets(
        EXPERIENCE_AUDIO_GENERATION_TARGETS.slice(1),
      ),
    ).toThrow(/partial/i);
  });

  it("parses Gemini and Docker as composable operator choices", () => {
    expect(
      parseExperienceAudioGeneratorArgs([
        "--provider=gemini",
        "--decoder=docker",
      ]),
    ).toEqual({ decoder: "docker", provider: "gemini" });
    expect(parseExperienceAudioGeneratorArgs([])).toEqual({
      decoder: "local",
      provider: "groq",
    });
    expect(
      parseExperienceAudioGeneratorArgs([
        "--decoder=docker",
        "--provider=macos",
      ]),
    ).toEqual({ decoder: "docker", provider: "macos" });
    expect(() =>
      parseExperienceAudioGeneratorArgs(["--provider=unknown"]),
    ).toThrow(/usage/i);
  });
});

describe("Experience audio pack generator", () => {
  it("requests exact Groq WAV payloads and atomically writes a deterministic pack", async () => {
    const outputDirectory = await temporaryOutputDirectory();
    const mp3 = await compatibleMp3();
    const fetchTts = successfulFetch();
    const run: ByteCommandRunner = vi.fn(async () => mp3);

    const result = await generateExperienceAudioPack({
      apiKey: "fixture-test-only-key",
      expectedMp3Bytes: mp3,
      fetchTts,
      outputDirectory,
      run,
    });

    expect(fetchTts).toHaveBeenCalledTimes(
      EXPERIENCE_AUDIO_GENERATION_TARGETS.length,
    );
    const [url, init] = fetchTts.mock.calls[0] ?? [];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/speech");
    expect(init).toMatchObject({
      headers: {
        authorization: "Bearer fixture-test-only-key",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      input: EXPERIENCE_AUDIO_GENERATION_TARGETS[0]?.transcript,
      model: "canopylabs/orpheus-v1-english",
      response_format: "wav",
      voice: "troy",
    });

    expect(result.manifest).toMatchObject({
      awayTeam: "FRA",
      homeTeam: "ARG",
      locale: "en",
      stream: {
        bitrateKbps: 48,
        channels: 1,
        codec: "mp3",
        sampleRateHz: 24_000,
      },
      templateId: "five-minute-match",
      templateVersion: 3,
    });
    expect(result.manifest.entries).toHaveLength(
      EXPERIENCE_AUDIO_GENERATION_TARGETS.length,
    );
    expect(result.manifest.entries[0]).toMatchObject({
      durationMs: expect.any(Number),
      mp3Path: EXPERIENCE_AUDIO_GENERATION_TARGETS[0]?.file,
      sha256: createHash("sha256").update(mp3).digest("hex"),
      transcript: EXPERIENCE_AUDIO_GENERATION_TARGETS[0]?.transcript,
    });

    const manifestBytes = await readFile(
      path.join(outputDirectory, "manifest.json"),
    );
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(
      result.manifestSha256,
    );
    await expect(
      readFile(
        path.join(
          outputDirectory,
          EXPERIENCE_AUDIO_GENERATION_TARGETS[0]?.file ?? "missing.mp3",
        ),
      ),
    ).resolves.toEqual(mp3);
  });

  it.each([
    {
      body: JSON.stringify({ error: { code: "model_terms_required" } }),
      expected: /model terms must be accepted/i,
      status: 403,
    },
    {
      body: JSON.stringify({ error: { message: "slow down" } }),
      expected: /rate limit/i,
      status: 429,
    },
  ])(
    "fails honestly for Groq HTTP $status without publishing a partial pack",
    async ({ body, expected, status }) => {
      const outputDirectory = await temporaryOutputDirectory();
      const mp3 = await compatibleMp3();
      const fetchTts = vi.fn(async () => new Response(body, { status }));

      await expect(
        generateExperienceAudioPack({
          apiKey: "fixture-test-only-key",
          expectedMp3Bytes: mp3,
          fetchTts,
          outputDirectory,
          run: async () => mp3,
        }),
      ).rejects.toThrow(expected);
      await expect(access(outputDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects an empty WAV and never invokes ffmpeg", async () => {
    const outputDirectory = await temporaryOutputDirectory();
    const mp3 = await compatibleMp3();
    const run: ByteCommandRunner = vi.fn(async () => mp3);

    await expect(
      generateExperienceAudioPack({
        apiKey: "fixture-test-only-key",
        expectedMp3Bytes: mp3,
        fetchTts: async () => new Response(Buffer.alloc(0), { status: 200 }),
        outputDirectory,
        run,
      }),
    ).rejects.toThrow(/empty WAV/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("removes staged files when a later provider request fails", async () => {
    const outputDirectory = await temporaryOutputDirectory();
    const mp3 = await compatibleMp3();
    let requestCount = 0;
    const fetchTts = vi.fn(async () => {
      requestCount += 1;
      return requestCount === 1
        ? new Response(wavBytes(), { status: 200 })
        : new Response("rate limited", { status: 429 });
    });

    await expect(
      generateExperienceAudioPack({
        apiKey: "fixture-test-only-key",
        expectedMp3Bytes: mp3,
        fetchTts,
        outputDirectory,
        run: async () => mp3,
      }),
    ).rejects.toThrow(/rate limit/i);
    await expect(access(outputDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects missing ffmpeg and incompatible MP3 output", async () => {
    const mp3 = await compatibleMp3();

    await expect(
      generateExperienceAudioPack({
        apiKey: "fixture-test-only-key",
        expectedMp3Bytes: mp3,
        fetchTts: successfulFetch(),
        outputDirectory: await temporaryOutputDirectory(),
        run: async () => {
          throw new Error("Audio transcoder is unavailable");
        },
      }),
    ).rejects.toThrow(/transcoder is unavailable/i);

    await expect(
      generateExperienceAudioPack({
        apiKey: "fixture-test-only-key",
        expectedMp3Bytes: mp3,
        fetchTts: successfulFetch(),
        outputDirectory: await temporaryOutputDirectory(),
        run: async () => Buffer.from("not an mp3"),
      }),
    ).rejects.toThrow(/not a compatible MP3 stream/i);
  });

  it("wraps ffmpeg in the selected Docker image without changing bytes or args", async () => {
    const output = Buffer.from("mp3");
    const delegate: ByteCommandRunner = vi.fn(async () => output);
    const docker = createDockerFfmpegRunner(
      delegate,
      "matchsense-debug:latest",
    );
    const input = Buffer.from("wav");

    await expect(
      docker({
        args: ["-hide_banner", "-i", "pipe:0"],
        command: "ffmpeg",
        input,
        timeoutMs: 20_000,
      }),
    ).resolves.toEqual(output);
    expect(delegate).toHaveBeenCalledWith({
      args: [
        "run",
        "--rm",
        "-i",
        "matchsense-debug:latest",
        "ffmpeg",
        "-hide_banner",
        "-i",
        "pipe:0",
      ],
      command: "docker",
      input,
      timeoutMs: 20_000,
    });
  });

  it("uses an injected WAV requester instead of calling Groq", async () => {
    const outputDirectory = await temporaryOutputDirectory();
    const mp3 = await compatibleMp3();
    const fetchTts = successfulFetch();
    const requestWav = vi.fn(async () => wavBytes());

    await generateExperienceAudioPack({
      expectedMp3Bytes: mp3,
      fetchTts,
      outputDirectory,
      requestWav,
      run: async () => mp3,
    });

    expect(requestWav).toHaveBeenCalledTimes(
      EXPERIENCE_AUDIO_GENERATION_TARGETS.length,
    );
    expect(fetchTts).not.toHaveBeenCalled();
  });

  it("accepts only Gemini WAV speech and preserves deterministic fallback reasons", async () => {
    const geminiSpeech = vi.fn(async () => ({
      bytes: wavBytes(),
      fallbackReason: null,
      provider: "gemini" as const,
    }));
    const requestGeminiWav = createGeminiExperienceWavRequester({
      synthesize: geminiSpeech,
    });

    await expect(
      requestGeminiWav(EXPERIENCE_AUDIO_GENERATION_TARGETS[0]!),
    ).resolves.toEqual(wavBytes());
    expect(geminiSpeech).toHaveBeenCalledWith(
      EXPERIENCE_AUDIO_GENERATION_TARGETS[0]?.transcript,
      "Kore",
    );

    const fallbackReason = "gemini_http_429";
    const rejectFallback = createGeminiExperienceWavRequester({
      synthesize: async () => ({
        bytes: wavBytes(),
        fallbackReason,
        provider: "deterministic-cue" as const,
      }),
    });
    await expect(
      rejectFallback(EXPERIENCE_AUDIO_GENERATION_TARGETS[0]!),
    ).rejects.toThrow(new Error(fallbackReason));
  });

  it("creates offline WAV narration with exact macOS command arguments and cleans up", async () => {
    const commands: Array<{ args: readonly string[]; command: string }> = [];
    let temporaryDirectory: string | null = null;
    const requestMacosWav = createMacosExperienceWavRequester({
      run: async (command) => {
        commands.push(command);
        if (command.command === "say") {
          temporaryDirectory = path.dirname(command.args[5]!);
          await writeFile(command.args[5]!, Buffer.from("aiff"));
        } else {
          await writeFile(command.args[5]!, wavBytes());
        }
      },
    });
    const target = EXPERIENCE_AUDIO_GENERATION_TARGETS[0]!;

    await expect(requestMacosWav(target)).resolves.toEqual(wavBytes());
    expect(commands).toEqual([
      {
        args: [
          "-v",
          "Daniel (English (UK))",
          "-r",
          "195",
          "-o",
          expect.stringMatching(/clip\.aiff$/u),
          target.transcript,
        ],
        command: "say",
      },
      {
        args: [
          "-f",
          "WAVE",
          "-d",
          "LEI16",
          expect.stringMatching(/clip\.aiff$/u),
          expect.stringMatching(/clip\.wav$/u),
        ],
        command: "afconvert",
      },
    ]);
    expect(temporaryDirectory).not.toBeNull();
    await expect(access(temporaryDirectory!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    { output: Buffer.alloc(0), expected: /empty WAV/i },
    { output: Buffer.from("not-wave"), expected: /invalid WAV/i },
  ])(
    "rejects invalid offline output and removes its private temp directory",
    async ({ expected, output }) => {
      let temporaryDirectory: string | null = null;
      const requestMacosWav = createMacosExperienceWavRequester({
        run: async (command) => {
          if (command.command === "say") {
            temporaryDirectory = path.dirname(command.args[5]!);
            await writeFile(command.args[5]!, Buffer.from("aiff"));
          } else {
            await writeFile(command.args[5]!, output);
          }
        },
      });

      await expect(
        requestMacosWav(EXPERIENCE_AUDIO_GENERATION_TARGETS[0]!),
      ).rejects.toThrow(expected);
      expect(temporaryDirectory).not.toBeNull();
      await expect(access(temporaryDirectory!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
