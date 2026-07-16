const sampleRates = {
  1: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  2.5: [11_025, 12_000, 8_000],
} as const;

const layer3Bitrates = {
  1: [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  2.5: [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;

export interface Mp3Contract {
  bitrateKbps: number;
  byteLength: number;
  channels: number;
  durationMs: number;
  frameCount: number;
  layer: 3;
  sampleRateHz: number;
  samplesPerFrame: number;
  version: 1 | 2 | 2.5;
}

function parseFrameHeader(bytes: Buffer, offset: number) {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    throw new Error(`incomplete MP3 header at byte ${offset}`);
  }
  if (first !== 0xff || (second & 0xe0) !== 0xe0) {
    throw new Error(`invalid MP3 frame sync at byte ${offset}`);
  }
  const versionBits = (second >> 3) & 0x03;
  const version: 1 | 2 | 2.5 =
    versionBits === 0x03
      ? 1
      : versionBits === 0x02
        ? 2
        : versionBits === 0
          ? 2.5
          : (() => {
              throw new Error(`reserved MP3 version at byte ${offset}`);
            })();
  if (((second >> 1) & 0x03) !== 0x01) {
    throw new Error(`only MP3 Layer III is supported at byte ${offset}`);
  }
  const bitrate = layer3Bitrates[version][(third >> 4) & 0x0f];
  const sampleRate = sampleRates[version][(third >> 2) & 0x03];
  if (!bitrate || !sampleRate)
    throw new Error(`invalid MP3 contract at byte ${offset}`);
  const padding = (third >> 1) & 1;
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const coefficient = version === 1 ? 144 : 72;
  return {
    bitrateKbps: bitrate,
    channels: fourth >> 6 === 3 ? 1 : 2,
    frameLength:
      Math.floor((coefficient * bitrate * 1000) / sampleRate) + padding,
    layer: 3 as const,
    sampleRateHz: sampleRate,
    samplesPerFrame,
    version,
  };
}

export function inspectMp3(bytes: Buffer): Mp3Contract {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error("MP3 bytes must be a non-empty Buffer");
  }
  let offset = 0;
  let frameCount = 0;
  let contract: ReturnType<typeof parseFrameHeader> | null = null;
  while (offset < bytes.length) {
    const frame = parseFrameHeader(bytes, offset);
    if (offset + frame.frameLength > bytes.length) {
      throw new Error(`incomplete MP3 frame at byte ${offset}`);
    }
    if (contract) {
      for (const key of [
        "version",
        "layer",
        "bitrateKbps",
        "sampleRateHz",
        "samplesPerFrame",
        "channels",
      ] as const) {
        if (contract[key] !== frame[key])
          throw new Error(`MP3 ${key} changes at byte ${offset}`);
      }
    } else contract = frame;
    offset += frame.frameLength;
    frameCount += 1;
  }
  if (!contract) throw new Error("MP3 contains no frames");
  return {
    bitrateKbps: contract.bitrateKbps,
    byteLength: bytes.length,
    channels: contract.channels,
    durationMs:
      (frameCount * contract.samplesPerFrame * 1000) / contract.sampleRateHz,
    frameCount,
    layer: contract.layer,
    sampleRateHz: contract.sampleRateHz,
    samplesPerFrame: contract.samplesPerFrame,
    version: contract.version,
  };
}

export function assertCompatibleMp3Streams(
  silence: Mp3Contract,
  cue: Mp3Contract,
) {
  for (const key of [
    "version",
    "layer",
    "bitrateKbps",
    "sampleRateHz",
    "samplesPerFrame",
    "channels",
  ] as const) {
    if (silence[key] !== cue[key]) {
      throw new Error(`MP3 ${key} differs`);
    }
  }
}
