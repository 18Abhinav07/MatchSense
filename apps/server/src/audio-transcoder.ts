import { spawn } from "node:child_process";

import {
  assertCompatibleMp3Streams,
  inspectMp3,
  type Mp3Contract,
} from "./mp3.js";

interface ByteCommand {
  command: string;
  args: readonly string[];
  input: Buffer;
  timeoutMs: number;
}

export type ByteCommandRunner = (command: ByteCommand) => Promise<Buffer>;

const FFMPEG_STREAM_ARGS = [
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
] as const;

export const runByteCommand: ByteCommandRunner = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Audio transcoding timed out")));
    }, command.timeoutMs);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(errors).length < 8_192) errors.push(Buffer.from(chunk));
    });
    child.once("error", () =>
      finish(() => reject(new Error("Audio transcoder is unavailable"))),
    );
    child.once("close", (code) => {
      if (code === 0) finish(() => resolve(Buffer.concat(output)));
      else {
        const detail = Buffer.concat(errors)
          .toString("utf8")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 240);
        finish(() =>
          reject(
            new Error(
              detail
                ? `Audio transcoding failed: ${detail}`
                : "Audio transcoding failed",
            ),
          ),
        );
      }
    });
    child.stdin.end(command.input);
  });

export async function transcodeWavToStreamMp3(
  wavBytes: Buffer,
  options: {
    expected: Mp3Contract;
    run?: ByteCommandRunner;
    timeoutMs?: number;
  },
) {
  if (!Buffer.isBuffer(wavBytes) || wavBytes.length === 0) {
    throw new Error("Commentary WAV must be a non-empty Buffer");
  }
  const bytes = await (options.run ?? runByteCommand)({
    args: FFMPEG_STREAM_ARGS,
    command: "ffmpeg",
    input: wavBytes,
    timeoutMs: options.timeoutMs ?? 20_000,
  });
  try {
    assertCompatibleMp3Streams(options.expected, inspectMp3(bytes));
  } catch {
    throw new Error("Generated commentary is not a compatible MP3 stream");
  }
  return bytes;
}
