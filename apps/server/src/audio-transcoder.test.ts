import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { inspectMp3 } from "./mp3.js";
import { transcodeWavToStreamMp3 } from "./audio-transcoder.js";

describe("runtime commentary transcoder", () => {
  it("requests the exact continuous-stream MP3 contract and validates the result", async () => {
    const compatibleMp3 = await readFile(
      new URL("../assets/goal-cue.mp3", import.meta.url),
    );
    const expected = inspectMp3(compatibleMp3);
    const run = vi.fn().mockResolvedValue(compatibleMp3);

    const result = await transcodeWavToStreamMp3(Buffer.from("RIFF"), {
      expected,
      run,
    });

    expect(result).toEqual(compatibleMp3);
    expect(run).toHaveBeenCalledWith({
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "wav",
        "-i",
        "pipe:0",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-ar",
        "44100",
        "-ac",
        "1",
        "-reservoir",
        "0",
        "-write_xing",
        "0",
        "-id3v2_version",
        "0",
        "-write_id3v1",
        "0",
        "-map_metadata",
        "-1",
        "-f",
        "mp3",
        "pipe:1",
      ],
      command: "ffmpeg",
      input: Buffer.from("RIFF"),
      timeoutMs: 20_000,
    });
  });

  it("rejects bytes that cannot join the persistent stream", async () => {
    const compatibleMp3 = await readFile(
      new URL("../assets/goal-cue.mp3", import.meta.url),
    );

    await expect(
      transcodeWavToStreamMp3(Buffer.from("RIFF"), {
        expected: inspectMp3(compatibleMp3),
        run: async () => Buffer.from("not an mp3"),
      }),
    ).rejects.toThrow("Generated commentary is not a compatible MP3 stream");
  });
});
