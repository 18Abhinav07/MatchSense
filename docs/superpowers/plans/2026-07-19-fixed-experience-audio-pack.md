---
created: 2026-07-19
project: matchsense
ecosystem: full-stack
tags: [implementation, experience, audio, pwa, commentary]
status: ready
---

# Fixed Experience Audio Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fixed Argentina–France Experience Match deliver immediate, polished stored commentary through Pocket Listening, foreground Moments, and Match Memory without any runtime Groq or Gemini request.

**Architecture:** An operator-only script generates a versioned MP3 pack from authored lines. Server startup validates that pack, and `ProductRuntime` resolves Experience Moments by their canonical `sourceEnvelopeId` beat key while live TxLINE Moments continue through the durable on-demand commentary worker. The same MP3 bytes and transcript serve active listeners and Memory replay.

**Tech Stack:** TypeScript, Fastify, React, Vitest, Groq Orpheus TTS, ffmpeg, existing AudioHub continuous MP3 transport.

[[../specs/2026-07-19-fixed-experience-audio-pack-design|Fixed Experience Audio Pack Design]] | [[2026-07-19-complete-experience-demo|Complete Experience Demo Plan]] | [[../../../../HANDOFF|MatchSense Handoff]]

---

## File map

- `apps/server/src/experience-audio-script.ts` — the reviewed English narration and immutable pack metadata.
- `scripts/generate-experience-audio.mts` — operator-only Groq/WAV/MP3 generation command.
- `apps/server/assets/experience/v3/en/manifest.json` — hashes, duration, transcript, and beat mapping.
- `apps/server/assets/experience/v3/en/*.mp3` — committed runtime assets.
- `apps/server/src/experience-audio-pack.ts` — fail-closed manifest loader and Moment resolver.
- `apps/server/src/product-runtime.ts` — authored Experience delivery; live generation remains unchanged.
- `apps/server/src/api-main.ts` and `apps/server/src/main.ts` — load and inject the validated pack.
- `packages/contracts/src/index.ts`, `apps/web/src/live-api.ts`, `apps/web/src/product-state.ts` — add the truthful `authored` commentary provider.
- `apps/web/src/features/experience/ExperienceSetup.tsx` — fixed Argentina–France presentation.
- `apps/web/src/features/experience/ExperienceMemory.tsx` — replay the same pack using media completion as the clock.

### Task 1: Lock the Experience fixture and authored narration

**Files:**
- Modify: `apps/server/src/experience-runtime.ts`
- Modify: `apps/server/src/experience-runtime.test.ts`
- Create: `apps/server/src/experience-audio-script.ts`
- Create: `apps/server/src/experience-audio-script.test.ts`

- [ ] **Step 1: Write failing fixed-fixture tests**

Add tests that start a run with Argentina–France and assert the stored fixture is
always `ARG` home and `FRA` away. Add an HTTP test proving any non-fixed pair is
rejected rather than silently receiving mismatched narration.

```ts
expect(runFixture).toMatchObject({ homeTeam: "ARG", awayTeam: "FRA" });
expect(wrongPair.statusCode).toBe(400);
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
corepack pnpm vitest run apps/server/src/experience-runtime.test.ts
```

Expected: FAIL because `StartExperienceRunInput` currently accepts arbitrary
teams and the setup derives the home team from the user's favourite.

- [ ] **Step 3: Export the fixed contract and version**

Implement these constants in `experience-runtime.ts` and validate input before
creating or preparing a fixture:

```ts
export const EXPERIENCE_HOME_TEAM: TeamCode = "ARG";
export const EXPERIENCE_AWAY_TEAM: TeamCode = "FRA";
export const EXPERIENCE_TEMPLATE_ID = "five-minute-match";
export const EXPERIENCE_TEMPLATE_VERSION = 3;

export function isFixedExperienceFixture(input: {
  homeTeam: TeamCode;
  awayTeam: TeamCode;
}) {
  return (
    input.homeTeam === EXPERIENCE_HOME_TEAM &&
    input.awayTeam === EXPERIENCE_AWAY_TEAM
  );
}
```

The API keeps the existing body shape for compatibility but rejects any other
pair with `INVALID_REQUEST`.

- [ ] **Step 4: Add the complete authored script registry**

Create `experience-audio-script.ts` with one line for every existing v3 beat and
one Memory introduction. All lines remain under Orpheus's 200-character input
limit and contain no player identity:

```ts
export const EXPERIENCE_AUDIO_SCRIPT = [
  ["kickoff", "The final is under way. Argentina in sky blue and white, France in deep blue. Five minutes of MatchSense starts now."],
  ["opening-goal", "Argentina have the ball in the net, but hold the celebration. The goal is still provisional."],
  ["opening-goal-var-review", "VAR is checking Argentina's goal. The score has not been confirmed."],
  ["opening-goal-var-stands", "The check is complete. The goal stands. Argentina lead France one nil."],
  ["home-yellow", "Yellow card for Argentina in the twenty-fourth minute."],
  ["away-yellow-first-half", "France now see yellow. One card for each side in this final."],
  ["away-penalty-awarded", "Penalty to France. A huge chance to level the match before half-time."],
  ["away-penalty-scored", "France score from the penalty spot. Argentina one, France one."],
  ["half-time", "Half-time in the final. Argentina one, France one. Everything is still open."],
  ["second-half", "The second half begins. Forty-five minutes in the match, two and a half minutes in this Experience."],
  ["away-red", "Red card for France. They are down to ten with the match level at one each."],
  ["home-yellow-second-half", "Another yellow card for Argentina as the pressure rises."],
  ["away-yellow-second-half", "France receive another yellow. Two cards arrive almost together."],
  ["winning-goal", "Goal for Argentina! They strike late and lead France two goals to one."],
  ["apparent-equalizer", "France have the ball in the net, but the equaliser is provisional. Celebration is held."],
  ["equalizer-var-review", "VAR is reviewing France's apparent equaliser. MatchSense is holding the score at two one."],
  ["equalizer-var-overturned", "No goal. VAR overturns the equaliser. Argentina still lead France two one."],
  ["late-corner", "Late corner for Argentina. They can take precious seconds out of the match."],
  ["regulation-end", "The final whistle is moments away. Argentina remain two one ahead."],
  ["full-time", "Full-time. Argentina beat France two goals to one after two VAR reviews and a dramatic finish."],
] as const;

export const EXPERIENCE_MEMORY_INTRO =
  "Here is your MatchSense match summary. Relive the decisive calls from Argentina against France.";
```

The registry test asserts unique beat keys, exact coverage against the exported
runtime beat keys, non-empty lines, and at most 200 characters per line.

- [ ] **Step 5: Run tests and commit**

```bash
corepack pnpm vitest run apps/server/src/experience-runtime.test.ts apps/server/src/experience-audio-script.test.ts
git add apps/server/src/experience-runtime.ts apps/server/src/experience-runtime.test.ts apps/server/src/experience-audio-script.ts apps/server/src/experience-audio-script.test.ts
git commit -m "feat: lock authored Argentina France experience"
```

### Task 2: Generate and validate the committed MP3 pack

**Files:**
- Create: `scripts/generate-experience-audio.mts`
- Create: `apps/server/assets/experience/v3/en/manifest.json`
- Create: `apps/server/assets/experience/v3/en/*.mp3`
- Modify: `.gitignore` only if a temporary WAV directory is currently ignored incorrectly

- [ ] **Step 1: Implement the operator-only generator**

The generator reads `GROQ_API_KEY`, requests WAV from Groq, passes the returned
bytes through `transcodeWavToStreamMp3`, verifies compatibility with
`apps/server/assets/silence.mp3`, and writes deterministic filenames plus the
manifest. The API call is exactly:

```ts
const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    input: transcript,
    model: "canopylabs/orpheus-v1-english",
    response_format: "wav",
    voice: "troy",
  }),
});
```

For every MP3, compute:

```ts
const contract = inspectMp3(mp3Bytes);
const sha256 = createHash("sha256").update(mp3Bytes).digest("hex");
```

The script exits non-zero on `model_terms_required`, rate limit, empty audio,
missing ffmpeg, incompatible MP3, duplicate key, or a partial manifest. It never
stores the key or raw response headers.

- [ ] **Step 2: Run the generator using Railway-provided environment values**

Use the currently linked MatchSense Railway service so no secret is copied into
the repository. Run the generator with the already-built MatchSense Docker
ffmpeg decoder if the workstation has no local ffmpeg.

Expected output: 21 successful assets, each mono 44.1 kHz 64 kbps MP3, followed
by one manifest hash. If Groq returns `model_terms_required`, stop and accept the
Orpheus model terms in the Groq organization before rerunning; do not fall back
to robotic synthetic speech.

- [ ] **Step 3: Verify every generated binary**

Run:

```bash
corepack pnpm exec tsx validation/spike-experience-audio-pack.mts
corepack pnpm run asset:check
```

Expected: the spike exits `0`; the asset rights check passes; manifest entries
equal the authored script count plus one Memory introduction.

- [ ] **Step 4: Commit the immutable pack**

```bash
git add scripts/generate-experience-audio.mts apps/server/assets/experience/v3/en
git commit -m "feat: add fixed experience commentary pack"
```

### Task 3: Add the fail-closed audio-pack loader

**Files:**
- Create: `apps/server/src/experience-audio-pack.ts`
- Create: `apps/server/src/experience-audio-pack.test.ts`

- [ ] **Step 1: Write failing loader tests**

Cover: valid real pack; missing file; wrong SHA-256; duplicate beat; absent
Memory intro; incompatible bitrate/sample rate/channel count; unknown beat; and
Moment resolution through `sourceEnvelopeId = "run-id:beat:winning-goal"`.

```ts
expect(pack.forMoment(moment)?.beatKey).toBe("winning-goal");
expect(pack.memoryIntro.transcript).toMatch(/match summary/i);
```

- [ ] **Step 2: Run and confirm failure**

```bash
corepack pnpm vitest run apps/server/src/experience-audio-pack.test.ts
```

Expected: FAIL because no loader exists.

- [ ] **Step 3: Implement the loader contract**

Expose only immutable values and copied buffers:

```ts
export interface ExperienceAudioAsset {
  beatKey: string;
  bytes: Buffer;
  durationMs: number;
  kind: string;
  minute: string;
  sha256: string;
  transcript: string;
}

export interface ExperienceAudioPack {
  forMoment(moment: CanonicalMoment): ExperienceAudioAsset | null;
  memoryIntro: ExperienceAudioAsset;
  templateId: "five-minute-match";
  templateVersion: 3;
}
```

`loadExperienceAudioPack(root)` must validate every entry and call
`assertCompatibleMp3Streams(inspectMp3(silence), inspectMp3(asset))`. A mismatch
throws during service startup; it never becomes a `commentary_not_ready` race.

- [ ] **Step 4: Run tests and commit**

```bash
corepack pnpm vitest run apps/server/src/experience-audio-pack.test.ts
git add apps/server/src/experience-audio-pack.ts apps/server/src/experience-audio-pack.test.ts
git commit -m "feat: validate experience audio pack"
```

### Task 4: Route Experience commentary through stored assets only

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/web/src/live-api.ts`
- Modify: `apps/web/src/product-state.ts`
- Modify: `apps/server/src/product-runtime.ts`
- Modify: `apps/server/src/product-commentary.test.ts`
- Modify: `apps/server/src/api-main.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/api-main.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create an Experience ProductRuntime with a fake validated pack and a commentary
pipeline whose `generate()` and `synthesize()` throw. Attach two listeners,
accept the fixed goal beat, and assert:

```ts
expect(commentaryPipeline.generate).not.toHaveBeenCalled();
expect(commentaryPipeline.synthesize).not.toHaveBeenCalled();
expect(commentaryEvent.commentary).toMatchObject({
  provider: "authored",
  usedFallback: false,
  text: fixedGoalTranscript,
});
expect(firstListenerAudio).toEqual(secondListenerAudio);
expect(await runtime.commentaryAudio(fixtureId, moment.identity)).toEqual(fixedMp3);
expect(await runtime.memoryIntroAudio(fixtureId)).toEqual(fixedIntroMp3);
```

Also assert a live TxLINE Moment still calls the existing live pipeline and does
not resolve an authored asset.

- [ ] **Step 2: Run and confirm failure**

```bash
corepack pnpm vitest run apps/server/src/product-commentary.test.ts apps/server/src/api-main.test.ts
```

Expected: FAIL because synthetic Experience currently enters Gemini runtime
generation and `CommentaryReady.provider` cannot represent authored audio.

- [ ] **Step 3: Add the authored provider and internal prepared type**

Change the shared contract to:

```ts
provider: "authored" | "gemini" | "deterministic";
```

In `ProductRuntime`, resolve the pack before considering the AI pipeline:

```ts
if (moment.provenance === "synthetic_txline_shaped") {
  const asset = options.experienceAudioPack?.forMoment(moment) ?? null;
  return asset
    ? Promise.resolve({
        audioBytes: Buffer.from(asset.bytes),
        generatedAt: moment.occurredAt ?? now(),
        id: `experience:${asset.beatKey}:v3`,
        provider: "authored" as const,
        text: asset.transcript,
        usedFallback: false,
      })
    : null;
}
```

Only the live branch may call `commentaryPipeline.generate`. Store authored
bytes in `commentaryAudioByMomentIdentity`, inject them through the existing
AudioHub delivery tail, and publish `commentary.ready` with the authored text.
Remove synthetic prewarming and runtime Memory-intro synthesis.

- [ ] **Step 4: Load the pack in both server entry paths**

`api-main.ts` and the integration harness in `main.ts` resolve
`../assets/experience/v3/en/manifest.json`, call the fail-closed loader once,
and pass `experienceAudioPack` only to the ProductRuntime used by Experience.
Real fixture runtimes do not receive it.

- [ ] **Step 5: Run tests and commit**

```bash
corepack pnpm vitest run packages/contracts apps/server/src/product-commentary.test.ts apps/server/src/api-main.test.ts apps/web/src/live-api.test.ts
corepack pnpm run typecheck
git add packages/contracts/src/index.ts apps/web/src/live-api.ts apps/web/src/product-state.ts apps/server/src/product-runtime.ts apps/server/src/product-commentary.test.ts apps/server/src/api-main.ts apps/server/src/main.ts apps/server/src/api-main.test.ts
git commit -m "feat: stream authored experience commentary"
```

### Task 5: Finish the fixed Experience and Memory user flow

**Files:**
- Modify: `apps/web/src/features/experience/ExperienceSetup.tsx`
- Modify: `apps/web/src/features/experience/ExperienceSetup.test.tsx`
- Modify: `apps/web/src/features/experience/experience-api.ts`
- Modify: `apps/web/src/features/experience/experience-api.test.ts`
- Modify: `apps/web/src/features/experience/ExperienceMemory.tsx`
- Modify: `apps/web/src/features/experience/ExperienceMemory.test.tsx`
- Modify: `apps/web/src/features/experience/ExperienceJourney.tsx`

- [ ] **Step 1: Write failing fixed-setup and Memory tests**

Assert the setup shows Argentina–France even when the user's favourite is
Brazil, submits only the fixed pair, and calls the Memory introduction before
the first key Moment. Simulate `ended` for intro and every Moment; verify the
visible Moment changes only after the corresponding `ended` event. Simulate
`error` and assert the current card remains visible with Retry and Skip.

- [ ] **Step 2: Run and confirm failure**

```bash
corepack pnpm vitest run apps/web/src/features/experience/ExperienceSetup.test.tsx apps/web/src/features/experience/ExperienceMemory.test.tsx apps/web/src/features/experience/experience-api.test.ts
```

Expected: setup FAILS because it currently substitutes the favourite team;
Memory integration tests expose a retryable error only after an absent runtime
artifact.

- [ ] **Step 3: Render the fixed fixture and simplify the start contract**

Resolve only catalog entries `ARG` and `FRA`, change the copy from “your chosen
team” to “Argentina versus France,” and make both Solo and Room buttons submit
that exact pair. Keep the simulation provenance rail visible throughout.

- [ ] **Step 4: Bind Memory captions to the authored transcript**

Keep the existing `onEnded` reducer as the only card-advance trigger. Use the
manifest-backed `commentary.ready` transcript list for captions. The intro text
is “Here is your MatchSense match summary,” and `onError` must hold the current
card until Retry or explicit Skip.

- [ ] **Step 5: Run tests and commit**

```bash
corepack pnpm vitest run apps/web/src/features/experience
corepack pnpm --filter @matchsense/web run build
git add apps/web/src/features/experience
git commit -m "feat: finish fixed experience audio journey"
```

### Task 6: Verify, deploy, and perform the physical iPhone gate

**Files:**
- Modify: `HANDOFF.md` outside `BUILD/` after evidence is known
- Modify: `sessions/2026-07-19-codex-hackathon.md` outside `BUILD/` append-only

- [ ] **Step 1: Run the focused and workspace verification**

```bash
corepack pnpm vitest run apps/server/src/experience-audio-script.test.ts apps/server/src/experience-audio-pack.test.ts apps/server/src/experience-runtime.test.ts apps/server/src/product-commentary.test.ts apps/web/src/features/experience
corepack pnpm run typecheck
corepack pnpm run build
git diff --check
```

Expected: all commands exit `0`; no test makes a real Groq/Gemini request.

- [ ] **Step 2: Run the no-provider integration proof**

Start the production server with `GROQ_API_KEY` and `GEMINI_API_KEY` absent,
create a fixed Experience run, attach Pocket Listening, advance to the goal,
and verify:

- `commentary.ready.provider === "authored"`;
- the Moment audio endpoint returns `200 audio/mpeg` immediately;
- the Memory intro returns `200 audio/mpeg` immediately;
- the continuous listening response contains the stored goal clip; and
- no provider HTTP request occurs.

- [ ] **Step 3: Review and push**

Run the required two stages: specification compliance against the approved
design, then code-quality review. Resolve only blocking findings. Push `main`
after both approve; Railway may then deploy the committed pack with no secret
dependency for Experience.

- [ ] **Step 4: Execute the physical-device acceptance path**

On the installed iPhone PWA:

```text
open Experience -> verify Argentina vs France -> Start Listening
-> confirm Connected -> lock phone -> hear kickoff
-> hear the confirmed goal call without reopening
-> pause and resume from native media controls
-> unlock -> finish match -> open Match Memory
-> hear intro fully -> verify each key card waits for its audio to finish
-> leave Experience -> verify the listening dock/session closes
```

Record separately whether Pocket Listening passed while merely locked and after
pause/resume. Do not call the device gate complete from automated tests alone.

## Self-review

- Spec coverage: fixed fixture, complete pack, no runtime provider, continuous
  stream injection, Moment audio, Memory intro/sequencing, live-pipeline
  isolation, startup readiness, and physical-device proof all map to tasks.
- Placeholder scan: every code change, failure state, command, and expected
  result is specified directly.
- Type consistency: `ExperienceAudioPack`, `ExperienceAudioAsset`, provider
  `authored`, template ID, template version, and beat keys are consistent across
  generator, loader, runtime, API, and web tasks.
