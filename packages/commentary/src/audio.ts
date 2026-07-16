import { createHash } from "node:crypto";

const WAV_HEADER_BYTES = 44;
const FALLBACK_SAMPLE_RATE = 24_000;
const FALLBACK_CHANNELS = 1;
const FALLBACK_BITS_PER_SAMPLE = 16;

export function wrapPcm16MonoAsWav(
  pcm: Buffer,
  sampleRate = FALLBACK_SAMPLE_RATE,
) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("PCM audio must contain complete signed 16-bit samples");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("PCM sample rate must be a positive integer");
  }

  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(FALLBACK_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(
    sampleRate * FALLBACK_CHANNELS * (FALLBACK_BITS_PER_SAMPLE / 8),
    28,
  );
  header.writeUInt16LE(FALLBACK_CHANNELS * (FALLBACK_BITS_PER_SAMPLE / 8), 32);
  header.writeUInt16LE(FALLBACK_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function squareWaveSample(sampleIndex: number, frequency: number) {
  const period = Math.max(2, Math.round(FALLBACK_SAMPLE_RATE / frequency));
  return sampleIndex % period < period / 2 ? 5_500 : -5_500;
}

export function createDeterministicFallbackCue() {
  const toneOneSamples = Math.round(FALLBACK_SAMPLE_RATE * 0.14);
  const silenceSamples = Math.round(FALLBACK_SAMPLE_RATE * 0.08);
  const toneTwoSamples = Math.round(FALLBACK_SAMPLE_RATE * 0.18);
  const pcm = Buffer.alloc(
    (toneOneSamples + silenceSamples + toneTwoSamples) * 2,
  );

  for (let index = 0; index < toneOneSamples; index += 1) {
    pcm.writeInt16LE(squareWaveSample(index, 660), index * 2);
  }
  for (
    let index = toneOneSamples;
    index < toneOneSamples + silenceSamples;
    index += 1
  ) {
    pcm.writeInt16LE(0, index * 2);
  }
  for (let index = 0; index < toneTwoSamples; index += 1) {
    const target = toneOneSamples + silenceSamples + index;
    pcm.writeInt16LE(squareWaveSample(index, 880), target * 2);
  }

  return wrapPcm16MonoAsWav(pcm, FALLBACK_SAMPLE_RATE);
}

export function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
