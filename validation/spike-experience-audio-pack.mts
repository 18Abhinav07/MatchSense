import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { createAudioHub } from "../apps/server/src/audio-hub.js";
import { createPacedMp3Chunks } from "../apps/server/src/mp3.js";

class Sink extends EventEmitter {
  chunks: Buffer[] = [];
  write(bytes: Buffer) {
    this.chunks.push(Buffer.from(bytes));
    return true;
  }
}

const audio = readFileSync("apps/server/assets/goal-cue.mp3");
const silence = readFileSync("apps/server/assets/silence.mp3");
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const memoryCopy = readFileSync("apps/server/assets/goal-cue.mp3");
assert.equal(hash(memoryCopy), hash(audio), "Memory must retrieve identical bytes");

const hub = createAudioHub({ cueBytes: audio, silenceBytes: silence, writeIntervalMs: 1_000 });
const sink = new Sink();
assert.equal(hub.addClient("listener-1", sink), true);
sink.chunks = [];
assert.equal(hub.inject("experience:opening-goal", ["listener-1"], audio), true);
const paced = createPacedMp3Chunks(audio, silence);
for (let index = 0; index < paced.length; index += 1) hub.writeSilence();
const streamed = Buffer.concat(sink.chunks);
const docker = process.env.MATCHSENSE_SPIKE_DECODER === "docker";
const decoded = spawnSync(
  docker ? "docker" : "ffmpeg",
  docker
    ? ["run", "--rm", "-i", "matchsense-debug:latest", "ffmpeg", "-hide_banner", "-i", "pipe:0", "-af", "volumedetect", "-f", "null", "-"]
    : ["-hide_banner", "-i", "pipe:0", "-af", "volumedetect", "-f", "null", "-"],
  { encoding: "utf8", input: streamed },
);
assert.equal(decoded.status, 0, decoded.stderr);
assert.match(decoded.stderr, /max_volume:\s*(?!-inf)[-\d.]+ dB/u);
console.log(JSON.stringify({ assetHash: hash(audio), pacedChunks: paced.length, streamedBytes: streamed.length }));
