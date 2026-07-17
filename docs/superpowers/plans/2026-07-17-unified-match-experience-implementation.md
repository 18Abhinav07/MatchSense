---
created: 2026-07-17
project: matchsense
ecosystem: full-stack
tags: [implementation, pwa, txline, experience-match, rooms]
status: active
---

# MatchSense Unified Experience Implementation Plan

> **For Codex:** Execute this plan in dependency order using focused test-first slices. Keep one canonical runtime for Demo, Experience, and live TxLINE. Deploy only after the integrated browser contract passes.

[[10-Projects/Web3-Builds/Hackathons/MatchSense/BUILD/docs/superpowers/specs/2026-07-17-unified-match-experience-design]] | [[10-Projects/Web3-Builds/Hackathons/MatchSense/specs/product-architecture]] | [[10-Projects/Web3-Builds/Hackathons/MatchSense/HANDOFF]]

## Delivery rule

The first usable milestone is not a page. It is one persisted Experience event completing the real contract:

`fan session -> fixture follow -> Start Listening -> canonical event -> foreground Moment + targeted push + commentary -> exact notification activation -> current truth`

Every later event and social feature must reuse that path.

## Task 1 — Canonical event and fixture truth

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/event-engine/src/index.ts`
- Modify: `packages/event-engine/src/index.test.ts`

**Build:**

- Add the complete canonical event union and full match phases.
- Separate regulation, extra-time, and shootout score truth.
- Give every Moment a stable family ID plus revision identity; never derive identity from score.
- Implement deterministic transitions for goals, cards, corners, penalties, VAR, phase changes, correction, and idempotent duplicates.
- Preserve backwards-compatible goal fields where current consumers require them during migration.

**Proof:**
`corepack pnpm --filter @matchsense/event-engine test && corepack pnpm --filter @matchsense/event-engine typecheck`

## Task 2 — Durable product records and fixture processor

**Files:**

- Modify: `packages/db/src/migrations.ts`
- Modify: `packages/db/src/repositories.ts`
- Modify: `packages/db/src/postgres.ts`
- Modify/add focused tests under `packages/db/src/`
- Add: `apps/server/src/fixture-processor.ts`
- Add: `apps/server/src/fixture-processor.test.ts`

**Build:**

- Persist fans/sessions, profiles, follows, alert preferences, devices, Experience runs/beats, canonical Moments/revisions, fixture events, Rooms, memberships, picks, reactions, results, Memories, and outbox delivery attempts.
- Use one transaction to dedupe source identity, lock/reduce fixture truth, append revision, update projection, append fixture event, and enqueue side effects.
- Keep raw live TxLINE payload retention disabled; synthetic source records may be retained.
- Provide an in-process repository adapter for tests and a PostgreSQL adapter for Railway.

**Proof:**
`corepack pnpm --filter @matchsense/db test && corepack pnpm --filter @matchsense/server test -- fixture-processor`

## Task 3 — Server-owned Experience Match and shared delivery

**Files:**

- Add: `apps/server/src/experience-runtime.ts`
- Add: `apps/server/src/experience-runtime.test.ts`
- Modify: `apps/server/src/product-runtime.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/outbox-worker.ts`
- Modify: `apps/server/src/push-subscriptions.ts`
- Modify: `apps/server/src/push-delivery.ts`
- Modify/add corresponding focused tests

**Build:**

- Create `ExperienceTemplate -> ExperienceRun` with server-owned due beats and unique `(runId, beatIndex)` delivery.
- Make progression independent of SSE/browser connections and resume after restart.
- Route Experience and TxLINE envelopes through the same fixture processor/event bus.
- Implement fan session/profile/follow/preferences APIs using HttpOnly session cookies and CSRF for mutations.
- Make push durable and targeted by fan/fixture/team/event preference.
- Add exact Moment resolver returning requested revision, latest family revision, superseded status, and current fixture truth.
- Wire outbox handlers after successful idempotent side effects.

**Proof:**
`corepack pnpm --filter @matchsense/server test && corepack pnpm --filter @matchsense/server typecheck`

## Task 4 — Cohesive installable PWA shell

**Files:**

- Modify: `apps/web/src/App.tsx`
- Modify/add components under `apps/web/src/features/`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/product-state.ts`
- Modify: `apps/web/src/live-api.ts`
- Modify/add focused web tests

**Build:**

- Add first ordinary-launch animation, favorite-team selection, unique handle, generated team avatar, sample Moment, alert/install primer, and Today entry.
- Add Profile with handle, avatar, team, alert/listening/language/accessibility preferences, device list, Room achievements, and sign-out/delete actions.
- Replace circular team tokens with rectangular textile-style flags everywhere.
- Build Today sections for live/upcoming/completed plus the pinned Experience Match.
- Build one Match Hub with Companion hero, expandable timeline, follow/alerts/listen controls, Room entry, and history/memory entry.
- Include loading, empty, offline, stale, denied-permission, muted, reduced-motion, desktop, and mobile states.

**Proof:**
`corepack pnpm --filter @matchsense/web test && corepack pnpm --filter @matchsense/web typecheck`

## Task 5 — Exact push activation and continuous commentary

**Files:**

- Modify: `apps/web/public/sw.js`
- Modify: `apps/web/src/push-notifications.ts`
- Modify: `apps/web/src/ListeningProvider.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/server/src/product-commentary.test.ts`
- Modify/add focused PWA tests

**Build:**

- Warm notification activation uses `postMessage + focus` and internal routing without reloading the audio root.
- Cold activation uses the exact Moment URL plus pending-activation recovery.
- Hydrate requested/current truth and render overturned/superseded Moments honestly.
- Keep factual cue/push immediate and commentary asynchronous.
- Cache commentary by moment family, revision, language, voice, and supporter relation; prewarm Experience/Demo audio.
- Preserve one persistent audio element and Media Session pause/resume/stop semantics; never claim playback after force-close.
- Version PWA shell cache and keep stream/API requests outside shell interception.

**Proof:**
`corepack pnpm --filter @matchsense/web test && corepack pnpm --filter @matchsense/server test -- product-commentary`

## Task 6 — Persistent Rooms and Sense scoring

**Files:**

- Modify: `packages/rooms/src/index.ts`
- Modify: `apps/server/src/room-service.ts`
- Modify: `apps/server/src/room-routes.ts`
- Modify: `apps/web/src/features/rooms/RoomExperience.tsx`
- Modify: `apps/web/src/features/rooms/model.ts`
- Modify: `apps/web/src/features/rooms/rooms.css`
- Modify/add Room tests

**Build:**

- Persist room lifecycle, hashed invites, memberships, picks, reactions, and final result.
- Give each member exactly 100 room-scoped confidence points across five fixed calls.
- Lock real matches at authentic kickoff; let Experience hosts start; late joiners spectate.
- Score `100 * correct resolved confidence / resolved confidence`; void unavailable stats and declare no winner when all calls void.
- Keep regulation-result semantics explicit and exclude ET/shootout from the five calls.
- Deliver controlled event-linked rival reactions only after match truth and hold/revise them through VAR.

**Proof:**
`corepack pnpm --filter @matchsense/rooms test && corepack pnpm --filter @matchsense/server test -- room && corepack pnpm --filter @matchsense/web test -- RoomExperience`

## Task 7 — Guided Demo, live schedule, history, and Memory

**Files:**

- Modify: `apps/server/src/demo-runtime.ts`
- Modify: `apps/server/src/demo-routes.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `packages/txline-adapter/src/`
- Modify: `packages/replay/src/index.ts`
- Modify: `apps/web/src/features/demo/`
- Modify/add focused tests

**Build:**

- Make Demo a guided controller over a real synthetic Experience run; exclude Rooms.
- Demonstrate kickoff, foreground event, push tap, listening, cards, penalty, VAR overturn/stands, reconnect catch-up, half-time, full-time, and Memory in about five minutes.
- Sync/persist the full optional-field-tolerant TxLINE schedule at startup and every five minutes; do not limit the UI to two fixtures.
- Map verified live TxLINE actions into the canonical union without inventing player names.
- Build server-backed History and revision-aware emotional Match Memory.
- Keep real historical replay feature-gated until written TxODDS retention/replay authorization exists.

**Proof:**
`corepack pnpm test && corepack pnpm typecheck`

## Task 8 — Integrated browser proof, deploy, and device handoff

**Files:**

- Add/modify browser smoke scripts under `scripts/`
- Modify: `README.md`
- Modify: `../HANDOFF.md`

**Build and prove:**

- Run migrations, all tests, typecheck, build, format check, asset-rights check, and container smoke.
- Browser-run two isolated fan sessions through onboarding, Experience follow/listen, Room join/picks, event/Moment, VAR revision, final score, and Memory.
- Browser-run Demo separately and verify it has no Room branch.
- Commit and push `main`; verify Railway deployment health and public browser journey.
- Hand off a short physical matrix for iPhone, Samsung tablet, macOS Safari/Chrome, and Windows browser. Mark only actually observed device states as PASS.

**Proof:**
`corepack pnpm test && corepack pnpm typecheck && corepack pnpm build && corepack pnpm format:check && corepack pnpm asset:check && corepack pnpm test:container`

## Scope guard

Do not add native apps, Dynamic Island, a global Sense wallet, transferable rewards, uploaded photos, player-specific calls without verified roster data, multi-replica coordination, or public replay of retained TxLINE payloads.
