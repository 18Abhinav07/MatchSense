---
created: 2026-07-19
project: matchsense
ecosystem: full-stack
tags: [implementation, experience, demo, pwa, listening, rooms]
---

# Complete Experience Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every behavior change follows RED -> GREEN and receives spec-compliance then code-quality review.

**Goal:** Ship one permanently available, clearly labelled five-minute Experience Match that exercises foreground Moments, real Web Push, locked-screen Pocket Listening, Call Three Rooms, reactions, final scoring, Match Memory, and replay without weakening any real TxLINE truth guard.

**Architecture:** The existing durable `ExperienceRuntime` remains the only synthetic source and continues writing `mode=demo`, `provenance=synthetic_txline_shaped` canonical facts. Those facts use the same projection, SSE, Moment, audio-hub, Room scoring, push-envelope, and Memory contracts as live facts, but cross into those consumers through explicit Experience-only adapters. Pocket Listening uses one same-origin continuous MP3 response started by a fan gesture; it never depends on suspended browser JavaScript to fetch or start each event audio.

**Tech Stack:** TypeScript, React 19, Fastify, PostgreSQL repositories, Web Push/VAPID, service workers, continuous CBR MP3 streaming, Vitest, Railway.

[[../../specs/2026-07-17-unified-match-experience-design|Unified Match Experience Design]] |
[[../2026-07-18-real-data-end-to-end-implementation|Real Data End-to-End Plan]] |
[[../../../../../../specs/product-architecture|Product Architecture]]

## Binding boundaries

- Experience UI, notifications, Room activity, audio, and Memory always show `EXPERIENCE · SIMULATED TXLINE-SHAPED DATA`.
- Live fixture follow, live durable push, archive replay, and real Room eligibility remain live/recorded-only exactly as today.
- No Experience record appears in real TODAY, real match history, global points, or live follower queries.
- A factual event revision renders before celebration, sponsor treatment, audio celebration, or reaction eligibility.
- Web Push is factual OS chrome. Rich motion starts only after opening the canonical Moment.
- Pocket Listening works only after the fan taps Start; force-quit or terminal Stop cannot autoplay it again.
- Experience commentary is prepared/cached and stream-format compatible; the five-minute judge path does not call Groq or Gemini.
- Room points are session-local friend points, finalised at full-time and retained in that Experience Memory.

### Task 1: Restore persistent Pocket Listening

**Files:**
- Modify: `apps/web/src/ListeningProvider.tsx`
- Modify: `apps/web/src/features/listening/ListeningControl.tsx`
- Create: `apps/web/src/features/listening/listening-api.ts`
- Modify: `apps/web/src/features/fixture/MatchHub.tsx`
- Modify: `apps/web/src/routes/AppRouter.tsx`
- Test: `apps/web/src/ListeningProvider.test.tsx`
- Test: `apps/web/src/features/listening/ListeningControl.test.tsx`
- Test: `apps/web/src/features/fixture/MatchHub.test.tsx`

- [ ] Write failing tests proving Start creates one fixture listening session, sets one unchanged stream URL, calls `play()` in the gesture, exposes `playing`, preserves the root audio element across navigation, and DELETEs on terminal Stop.
- [ ] Write failing tests proving Pause is non-terminal and native Play creates a fresh live-edge session/stream rather than replaying buffered audio.
- [ ] Run the focused tests and confirm failure because the current artifact-per-event controller never creates a listening session.
- [ ] Replace the foreground artifact controller with a session-backed continuous transport and mount `ListeningControl` on every active Match/Experience surface.
- [ ] Keep honest `connecting`, `listening`, `paused`, `reconnecting`, `blocked`, and `stopped` UI; captions remain driven by canonical commentary SSE when foregrounded.
- [ ] Run focused web tests, typecheck, and commit `feat: restore persistent pocket listening`.

### Task 2: Complete the server-owned Experience fixture and delivery adapters

**Files:**
- Modify: `apps/server/src/experience-runtime.ts`
- Modify: `apps/server/src/experience-runtime.test.ts`
- Create: `apps/server/src/experience-delivery.ts`
- Create: `apps/server/src/experience-delivery.test.ts`
- Modify: `apps/server/src/product-runtime.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/durable-push.ts`
- Modify: `apps/server/src/push-delivery.ts`
- Test: `apps/server/src/product-contract.test.ts`
- Test: `apps/web/src/push-notification-contract.test.ts`

- [ ] Write failing tests for the exact five-minute authored sequence: kickoff; provisional goal; VAR started/stands; cards; penalty awarded/scored; half-time; second half; red; two catch-up events; winning goal; apparent equalizer; VAR overturned; corner; full-time.
- [ ] Assert final truth is home 2-1, total goals 3, total cards 5, and each beat is idempotent across duplicate tick/restart.
- [ ] Write failing delivery tests proving an opted-in Experience participant receives only confirmed goal, red-card, and full-time pushes, each labelled EXPERIENCE and routed to the exact revision, while `deliverToFixture(..., "demo")` remains blocked.
- [ ] Add an Experience-only fan delivery method that targets run participants directly and cannot query or mutate live follows.
- [ ] Add a prepared Experience commentary registry whose MP3 segments match the continuous stream contract and inject into active fixture listening sessions without runtime AI calls.
- [ ] Preserve server-owned kickoff/recovery and expose run status plus exact fixture identity required by the PWA.
- [ ] Run focused server/push/audio tests, typecheck, and commit `feat: complete experience match delivery`.

### Task 3: Build the complete Solo Experience PWA

**Files:**
- Create: `apps/web/src/features/experience/experience-api.ts`
- Create: `apps/web/src/features/experience/ExperienceSetup.tsx`
- Create: `apps/web/src/features/experience/ExperienceMatch.tsx`
- Create: `apps/web/src/features/experience/ExperienceMoment.tsx`
- Create: `apps/web/src/features/experience/experience.css`
- Modify: `apps/web/src/features/today/TodayHub.tsx`
- Modify: `apps/web/src/routes/AppRouter.tsx`
- Modify: `apps/web/src/push-notifications.ts`
- Modify: `apps/web/public/push-notification.js`
- Test: corresponding `*.test.tsx` and push contract tests

- [ ] Write failing route/UI tests for `/experience`, readiness, Solo/Room choice, team perspective, install/push capability, test push, Start Pocket Listening, countdown, and fixture navigation.
- [ ] Write failing reducer tests proving factual score-first rendering, VAR celebration hold, stands celebration, overturn walk-back, exact revision replacement, reconnect catch-up without duplicate Moment, and full-time transition.
- [ ] Implement one premium responsive Experience surface using existing textured team flags, Truth Rail, Moment cinema, captions, reduced motion, and source rail; never render fake native notification chrome.
- [ ] Implement actual push opt-in/registration and test delivery from the readiness surface; permission denial keeps the foreground demo usable.
- [ ] Wire one intentional client SSE gap during the authored two-event window and prove `Caught you up - 2 things happened` uses Last-Event-ID.
- [ ] Run focused UI/contract tests, web typecheck/build, and commit `feat: add solo experience journey`.

### Task 4: Add Experience Rooms and Call Three

**Files:**
- Create: `apps/server/src/experience-room-service.ts`
- Create: `apps/server/src/experience-room-service.test.ts`
- Modify: `apps/server/src/durable-room-routes.ts`
- Modify: `packages/rooms/src/index.ts`
- Modify: `apps/web/src/features/rooms/room-api.ts`
- Modify: `apps/web/src/features/rooms/types.ts`
- Modify: `apps/web/src/features/rooms/RoomExperience.tsx`
- Modify: `apps/web/src/routes/AppRouter.tsx`
- Test: Room domain/server/web contract tests

- [ ] Write failing tests for an Experience Room bound to a prepared Experience fixture with a five-minute lobby, invite link, real fan joins, exact Call Three slate, per-member lock, early host start only when all joined members are locked, automatic kickoff at the deadline, and late spectator behavior.
- [ ] Prove real `createDurableRoomService` still rejects demo/recorded fixtures; implement the Experience adapter by reusing pure Call Three scoring/reaction rules rather than weakening `assertEligibleFixture`.
- [ ] Write failing tests for provisional leaderboard projection, confirmed-revision reaction eligibility, VAR reaction hold/overturn, rate limits, and final 2-1/3-goal/5-card scoring.
- [ ] Add clearly labelled optional demo supporters for a solo judge; they exist only inside the Experience Room aggregate and never become Fan profiles.
- [ ] Implement responsive lobby, share link/QR fallback, calls, confidence assignment, leaderboard, ROAR/COLD/CALLED IT, reconnect, and full-time state.
- [ ] Run focused Room tests, typechecks, and commit `feat: add experience call three rooms`.

### Task 5: Final Memory, replay, device gates, and deployment

**Files:**
- Modify: `apps/server/src/memory-service.ts`
- Modify: `apps/server/src/memory-routes.ts`
- Modify: `apps/web/src/features/memory/MemorySurface.tsx`
- Modify: `apps/web/src/routes/AppRouter.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/public/manifest.webmanifest`
- Modify: `README.md`
- Modify: `docs/`

- [ ] Write failing tests proving full-time materialises one Experience Memory containing final score, canonical Moments/revisions, commentary transcripts/audio references, Room calls/leaderboard/reactions, provenance, share route, and restart metadata.
- [ ] Implement condensed replay using the stored five-minute facts/audio; replay never sends push, reopens a Room, or claims LIVE.
- [ ] Verify responsive/loading/error/offline/permission-denied/reduced-motion/muted-audio states at 390px, tablet, and desktop widths.
- [ ] Run the full workspace test, typecheck, build, release check, and rights/secret scans once.
- [ ] Deploy the reviewed branch to Railway, then physically gate iPhone, Samsung tablet, and Mac: foreground Moment; background push; locked Pocket Listening; exact notification tap; pause/resume; Room across two devices; full-time Memory.
- [ ] Merge to `main`, push, update `HANDOFF.md`, and commit `feat: ship complete matchsense experience` only after the required gates pass or are explicitly labelled open.

## Acceptance contract

The demo is complete only when one judge can finish Solo without another account, two real devices can finish a Room, the locked iPhone hears server-injected commentary after one Start tap, and a real OS push opens the identical canonical Moment revision. A foreground-only audio file player, fake lock-screen visual, client-only timer, demo data on live routes, or Room scoring outside canonical final facts is a release failure.
