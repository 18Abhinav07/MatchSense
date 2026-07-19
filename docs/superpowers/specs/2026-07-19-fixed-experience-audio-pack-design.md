---
created: 2026-07-19
project: matchsense
ecosystem: full-stack
tags: [design, experience, audio, pwa, commentary]
status: approved
---

# Fixed Experience Audio Pack Design

[[10-Projects/Web3-Builds/Hackathons/MatchSense/specs/product-architecture|Product Architecture]] | [[2026-07-17-unified-match-experience-design|Verified Match Experience Design]] | [[../plans/2026-07-19-complete-experience-demo|Complete Experience Demo Plan]]

## Decision

The always-available Experience Match is a fixed, five-minute Argentina–France
simulation. It is permanently labelled `EXPERIENCE · SIMULATED MATCH`; it never
appears in Real mode and never claims to be current or recorded TxLINE data.

Every Experience commentary line is authored and generated once. Experience
runtime, Pocket Listening, Moment replay, and Match Memory must never call an
LLM or TTS provider. Runtime Groq/Gemini generation remains available only for
real canonical TxLINE events.

## Asset contract

One versioned manifest is the source of truth:

```ts
type ExperienceAudioEntry = {
  beatKey: string;
  durationMs: number;
  kind: CanonicalEventKind | "memory.intro";
  minute: string;
  mp3Path: string;
  sha256: string;
  transcript: string;
};

type ExperienceAudioManifest = {
  awayTeam: "FRA";
  entries: readonly ExperienceAudioEntry[];
  homeTeam: "ARG";
  stream: {
    bitrateKbps: 64;
    channels: 1;
    codec: "mp3";
    sampleRateHz: 44100;
  };
  templateId: "five-minute-match";
  templateVersion: 3;
};
```

Assets live under `apps/server/assets/experience/v3/en/`. The pack contains one
clip for every authored beat plus `memory-intro.mp3`. Each MP3 is checked at
build time for existence, hash, duration, and compatibility with the continuous
stream contract.

## Runtime flow

```text
Experience beat becomes canonical
  -> resolve beatKey in the immutable manifest
  -> publish the saved transcript as commentary.ready
  -> inject the saved MP3 once into every active fixture listening session
  -> expose the same audio reference on the Moment
  -> retain the same reference in Match Memory
```

There is no provider fallback in Experience mode. A missing or invalid entry is
a deployment error: Start Experience is disabled and readiness reports the
pack failure. The UI never substitutes a robotic cue while claiming commentary
is available.

## Playback rules

- `Start Listening` remains the single user gesture that starts one continuous,
  same-origin MP3 response. Stored clips are inserted into that stream, so the
  existing iOS media session and lock-screen controls remain in use.
- The OS Web Push remains factual text. It does not contain or autoplay audio.
- Foreground Moment captions use the manifest transcript.
- Match Memory begins with the stored introduction and advances only from the
  media element's `ended` event; it does not use an arbitrary card timer.
- Leaving or ending Experience stops its listening session and removes the Live
  Dock. Pause remains resumable through the native media controls.

## Generation workflow

An operator-only script sends the approved short scripts to Groq Orpheus TTS,
writes temporary WAV files, transcodes them through the existing ffmpeg path to
the exact stream MP3 contract, measures duration, computes SHA-256, and writes
the manifest. The API key is read from the environment and never embedded in
the repository. Generated audio is committed so Railway needs no TTS key to run
the Experience.

## Acceptance

The fixed pack is accepted only when:

1. All Experience beats and the Memory introduction resolve to valid files.
2. A saved goal clip is audibly decodable after AudioHub pacing.
3. Two simultaneous listeners receive the same clip from one event injection.
4. Starting Experience succeeds with Groq and Gemini keys absent.
5. Pocket Listening continues while the installed iPhone is locked.
6. Match Memory plays the introduction and each key clip fully before changing
   cards.
7. Real mode still routes canonical TxLINE events through the existing durable
   on-demand commentary worker.
