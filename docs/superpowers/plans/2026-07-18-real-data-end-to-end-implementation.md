---
created: 2026-07-18
project: matchsense
ecosystem: full-stack
tags: [implementation, txline, pwa, railway, replay, rooms, listening]
status: active
---

# MatchSense Real-Data End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task by
> task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current mixed demo/live PWA with a truthful, installable
World Cup companion whose live and recorded experiences use one durable TxLINE
truth pipeline.

**Architecture:** A Railway `collector-worker` alone owns TxLINE schedule,
historical recovery, SSE ingestion, canonical reduction, archive verification,
commentary jobs, and source-derived outbox work. A separate `api-pwa` service
owns the PWA, anonymous fan sessions, fan mutations, database-backed reads/SSE,
push registration, listening delivery, Rooms, and replay sessions. PostgreSQL
is the only durable source of product truth.

**Tech Stack:** TypeScript, Fastify, React, Vite PWA/service worker,
PostgreSQL, Railway, TxLINE, Web Push/VAPID, Gemini/Groq commentary/TTS, FFmpeg.

---

[[../specs/2026-07-17-matchsense-technical-architecture|Technical Architecture]] |
[[../specs/2026-07-17-unified-match-experience-design|Product Contract]] |
[[../../../../validation/spike-results|Gate A Evidence]] |
[[../../../../HANDOFF|Project Handoff]]

## Scope and hard boundaries

The build includes: truthful schedule/history, profile/follows, Live Companion,
revision-safe Moments, server-cached factual commentary, standard Web Push,
Call Three Rooms, verified Memory, and authorised Recorded Replay.

The build excludes: public synthetic Demo/Experience routes, elapsed-time final
inference, local browser-created history, native notification surfaces,
financial language/mechanics, player calls, corner calls, open chat, and ads.

Every task must preserve these rules:

```ts
type ProductMode = "live" | "recorded";
type DataProvenance = "live_txline" | "recorded_txline_authorised";
type DeliveryIntent = "realtime" | "reconcile";

// Only a realtime confirmed canonical revision may create fan-side effects.
const createsFanEffect =
  event.deliveryIntent === "realtime" && event.status === "confirmed";
```

Gate A has passed. Recorded Replay may be implemented only from a verified
archive manifest. Push, locked Listening, and Rooms still require their own
acceptance evidence before being advertised as universally available.

## File ownership map

| Area            | Primary files                                                             | Responsibility                                                             |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Durable schema  | `packages/db/src/migrations.ts`, `repositories.ts`, `postgres.ts`         | fixture/source/archive/job truth and transactional repositories            |
| TxLINE boundary | `packages/txline-adapter/src/{raw-source,live,schedule}.ts`               | raw delivery, action classification, schedule parsing                      |
| Worker          | `apps/server/src/{entry,collector-main}/`                                 | schedule, source lease, archive, reduction, outbox, commentary             |
| API             | `apps/server/src/{entry,api-main,api-app}.ts`                             | Fastify/PWA, profile, fixture read/SSE, push/listening/replay/Room APIs    |
| PWA truth state | `apps/web/src/{live-api,product-state}.ts`                                | typed DTOs, ordered cursor reducer, lifecycle/freshness                    |
| PWA surfaces    | `apps/web/src/features/`                                                  | onboarding, Today, fixture, Moment, listening, push, Memory, replay, Rooms |
| Platform        | `apps/web/public/{sw,push-notification}.js`, `Dockerfile`, `railway.json` | service worker and two Railway role deployment                             |

## Task 1: Establish live/recorded durable truth

**Files:**

- Modify: `packages/db/src/migrations.ts`
- Modify: `packages/db/src/repositories.ts`
- Modify: `packages/db/src/postgres.ts`
- Modify: `packages/db/src/index.ts`
- Add: `packages/db/src/archive-repositories.ts`
- Add: `packages/db/src/commentary-job-repository.ts`
- Test: `packages/db/src/migrations.test.ts`
- Test: `packages/db/src/postgres.integration.test.ts`
- Test: `packages/db/src/archive-repositories.test.ts`
- Test: `packages/db/src/commentary-job-repository.test.ts`

- [ ] **Step 1: Write failing repository tests for the real-data contract.**

  Cover these exact assertions before the migration/repository changes:

  ```ts
  expect(await archive.insertDelivery(sourceOnlyDelivery)).toMatchObject({
    inserted: true,
    canonicalEligible: false,
  });
  expect(await archive.insertDelivery(sourceOnlyDelivery)).toMatchObject({
    inserted: false,
    duplicate: true,
  });
  expect(await archive.verify(fixtureId)).toMatchObject({
    status: "REPLAY_READY",
  });
  expect(await jobs.claim("worker-a", now)).toMatchObject({
    status: "claimed",
  });
  ```

- [ ] **Step 2: Run only those tests and confirm red.**

  Run: `corepack pnpm exec vitest run packages/db/src/archive-repositories.test.ts packages/db/src/commentary-job-repository.test.ts`

  Expected: failures because archive/job repositories do not exist.

- [ ] **Step 3: Add forward-only migration 4.**

  The migration must:

  ```sql
  -- Public product modes are live/recorded only. Delete prior synthetic rows
  -- before tightening constraints; test fixtures remain outside Railway data.
  DELETE FROM matchsense.fixtures WHERE mode = 'demo';
  ALTER TABLE matchsense.fixtures DROP CONSTRAINT fixtures_mode_check;
  ALTER TABLE matchsense.fixtures
    ADD CONSTRAINT fixtures_mode_check CHECK (mode IN ('live', 'recorded'));

  CREATE TABLE matchsense.fixture_schedule_observations (...);
  CREATE TABLE matchsense.rights_grants (... active boolean NOT NULL ...);
  CREATE TABLE matchsense.archive_manifests (... status text NOT NULL ...);
  CREATE TABLE matchsense.archive_manifest_entries (... ordering_key text NOT NULL ...);
  CREATE TABLE matchsense.commentary_jobs (... status text NOT NULL ...);
  ```

  Extend raw source rows with non-null `delivery_intent`, `ordering_key`,
  `source_path`, `stream_key`, `response_hash`, `rights_grant_id`, and explicit
  raw-retention state. Authorised raw historical/live records retain their
  payload; a source-only record is immutable and cannot generate fixture events.
  Add indexes for `(fixture_id, ordering_key)`, replay-ready finals, and
  `commentary_jobs` `FOR UPDATE SKIP LOCKED` claims.

- [ ] **Step 4: Implement typed archive and job repositories.**

  Export these minimum contracts from `packages/db/src/index.ts`:

  ```ts
  interface ArchiveRepository {
    insertDelivery(input: DurableSourceDelivery): Promise<InsertDeliveryResult>;
    orderedDeliveries(
      fixtureId: string,
    ): Promise<readonly DurableSourceDelivery[]>;
    verifyArchive(input: VerifyArchiveInput): Promise<ArchiveManifest>;
    invalidateArchive(fixtureId: string, reason: string): Promise<void>;
    replayReady(fixtureId: string): Promise<ArchiveManifest | null>;
  }

  interface CommentaryJobRepository {
    enqueue(input: CommentaryJobInput): Promise<CommentaryJob>;
    claim(workerId: string, now: Date): Promise<CommentaryJob | null>;
    complete(input: CompletedCommentaryJob): Promise<void>;
    fail(input: FailedCommentaryJob): Promise<void>;
    supersede(
      fixtureId: string,
      familyId: string,
      revision: number,
    ): Promise<void>;
  }
  ```

  `enqueue` has a unique key `(fixture, family, revision, language, voice,
templateVersion)`. A job becomes `ready` only in the same transaction that
  saves non-empty MP3 bytes and hashes.

- [ ] **Step 5: Run repository and migration tests green.**

  Run: `corepack pnpm exec vitest run packages/db/src/migrations.test.ts packages/db/src/archive-repositories.test.ts packages/db/src/commentary-job-repository.test.ts`

  Expected: pass, including duplicate delivery, source-only no-event,
  correction invalidation, job reclaim, failure, and ready-artifact reuse.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/db
  git commit -m "feat: add durable live and recorded archive foundation"
  ```

## Task 2: Split API and collector roles

**Files:**

- Add: `apps/server/src/entry.ts`
- Add: `apps/server/src/api-main.ts`
- Add: `apps/server/src/collector-main.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/start.ts`
- Modify: `Dockerfile`
- Modify: `railway.json`
- Test: `apps/server/src/entry.test.ts`
- Test: `apps/server/src/config.test.ts`

- [ ] **Step 1: Write failing role-isolation tests.**

  ```ts
  expect(() => parseServerEnv(apiEnvWithTxlineToken)).toThrow(
    "API role must not receive TxLINE token",
  );
  expect(() => parseServerEnv(workerEnvWithoutTxlineToken)).toThrow(
    "TxLINE token is required",
  );
  expect(startedApi.collectorStarted).toBe(false);
  expect(startedWorker.fastifyStarted).toBe(false);
  ```

- [ ] **Step 2: Verify red.**

  Run: `corepack pnpm exec vitest run apps/server/src/config.test.ts apps/server/src/entry.test.ts`

- [ ] **Step 3: Implement role configuration and entry dispatch.**

  ```ts
  type ServerRole = "api" | "worker";

  export async function startByRole(env: NodeJS.ProcessEnv) {
    const config = parseServerEnv(env);
    return config.role === "api" ? startApi(config) : startCollector(config);
  }
  ```

  `api-main.ts` may serve Fastify/static files, open PostgreSQL, and start
  database-backed listeners. It imports neither TxLINE client nor source loop.
  `collector-main.ts` owns migration lock, source lease, collector, outbox, and
  commentary workers; it does not bind public HTTP routes. Replace `main.ts`
  with an import-compatible re-export only, then remove it once callers use
  `entry.ts`.

- [ ] **Step 4: Configure one image/two Railway services.**

  `Dockerfile` runs `node apps/server/dist/entry.js`. The Railway API service
  has `ROLE=api`, no `TXLINE_API_TOKEN`; the worker has `ROLE=worker` and the
  token. Both share `DATABASE_URL`; only API has a public domain.

- [ ] **Step 5: Verify green.**

  Run: `corepack pnpm exec vitest run apps/server/src/config.test.ts apps/server/src/entry.test.ts`

- [ ] **Step 6: Commit.**

  ```bash
  git add apps/server Dockerfile railway.json
  git commit -m "feat: split MatchSense API and collector roles"
  ```

## Task 3: Build the durable TxLINE collector and archive verification

**Files:**

- Add: `apps/server/src/collector/schedule-sync.ts`
- Add: `apps/server/src/collector/txline-collector.ts`
- Add: `apps/server/src/collector/archive-service.ts`
- Add: `packages/txline-adapter/src/durable-reducer.ts`
- Modify: `apps/server/src/fixture-processor.ts`
- Modify: `packages/txline-adapter/src/{live,raw-source}.ts`
- Test: `apps/server/src/collector/{schedule-sync,txline-collector,archive-service}.test.ts`
- Test: `packages/txline-adapter/src/durable-reducer.test.ts`

- [ ] **Step 1: Write failing recovery/reducer tests.**

  ```ts
  const first = await collector.ingest(rawGoal, { intent: "realtime" });
  const duplicate = await collector.ingest(rawGoal, { intent: "reconcile" });
  expect(first.effects).toContain("fixture_event");
  expect(duplicate.effects).toEqual([]);

  const rebuilt = await archive.rebuild(fixtureId);
  expect(rebuilt.projectionHash).toBe(first.projectionHash);
  expect(rebuilt.status).toBe("REPLAY_READY");
  ```

- [ ] **Step 2: Verify red.**

  Run: `corepack pnpm exec vitest run apps/server/src/collector packages/txline-adapter/src/durable-reducer.test.ts`

- [ ] **Step 3: Implement schedule and raw-delivery ownership.**

  `schedule-sync.ts` persists every source-timestamped schedule observation;
  it may only revise participants/kickoff before a fixture is tracking/live.
  `txline-collector.ts` uses `createTxlineRawScoreSource`, persists the exact
  delivery before reduction, then advances the cursor in that transaction. It
  maps `reconciliation` to truth/history-only intent and never asks the API to
  create an in-app celebration.

  Preserve the observed action classification:

  ```ts
  type ReductionResult =
    | { kind: "canonical"; event: CanonicalEvent }
    | { kind: "source_only"; source: TxlineSourceOnlyRecord }
    | { kind: "unsupported"; warning: TxlineWarning };
  ```

  Source-only action results are manifest entries only. They never call
  `fixture-processor` or write outbox side effects.

- [ ] **Step 4: Implement deterministic archive verification.**

  `archive-service.ts` reads ordered deliveries, rebuilds using the pure
  reducer, requires terminal `game_finalised`, `statusId === 100`, and
  `confirmed !== false`, hashes the ordered manifest/projection/reducer version,
  then sets `REPLAY_READY`. A correction sets `REPLAY_INVALIDATED` before
  rebuild. API readers hide invalid/unverified archives.

- [ ] **Step 5: Verify green.**

  Run: `corepack pnpm exec vitest run apps/server/src/collector packages/txline-adapter/src/durable-reducer.test.ts`

- [ ] **Step 6: Commit.**

  ```bash
  git add apps/server/src/collector apps/server/src/fixture-processor.ts packages/txline-adapter
  git commit -m "feat: collect and verify durable TxLINE match archives"
  ```

## Task 4: Expose repository-backed fixture, history, and replay APIs

**Files:**

- Add: `apps/server/src/fixture-read-routes.ts`
- Add: `apps/server/src/fixture-stream-routes.ts`
- Add: `apps/server/src/replay-routes.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/fan-routes.ts`
- Modify: `apps/server/src/memory-{service,routes}.ts`
- Modify: `packages/db/src/{archive-repositories,product-repositories}.ts`
- Test: `apps/server/src/{fixture-read-routes,fixture-stream-routes,replay-routes}.test.ts`

- [ ] **Step 1: Write failing API contracts.**

  ```ts
  expect(
    (await app.inject("/api/v1/fixtures?bucket=final")).json().fixtures,
  ).toEqual([
    expect.objectContaining({
      lifecycle: "FINAL",
      score: { home: 2, away: 1 },
    }),
  ]);
  expect(
    (await app.inject("/api/v1/fixtures/fx/stream?after=8")).body,
  ).toContain("id: fx:9");
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/replay/sessions",
        payload: { fixtureId: "unverified" },
      })
    ).statusCode,
  ).toBe(409);
  ```

- [ ] **Step 2: Verify red.**

  Run: `corepack pnpm exec vitest run apps/server/src/fixture-read-routes.test.ts apps/server/src/fixture-stream-routes.test.ts apps/server/src/replay-routes.test.ts`

- [ ] **Step 3: Implement lifecycle-only fixture reads and cursor SSE.**

  Expose only server-derived DTOs:

  ```text
  GET /api/v1/catalog
  GET /api/v1/fixtures?bucket=live|upcoming|final
  GET /api/v1/fixtures/:fixtureId
  GET /api/v1/fixtures/:fixtureId/stream?after=<seq>
  GET /api/v1/fixtures/:fixtureId/moments/:familyId?revision=<n>
  GET /api/v1/fixtures/:fixtureId/memory
  GET /api/v1/history
  ```

  Stream bootstrap is one transaction: snapshot at high-water `N`, then all
  events `(after, N]`; native `Last-Event-ID` wins over query `after`. An invalid
  cursor emits `stream.reset`; active streams heartbeat every 15s and query the
  durable log every 5s. No route derives final state from elapsed time.

- [ ] **Step 4: Implement recorded replay sessions.**

  ```text
  POST /api/v1/replay/sessions { fixtureId }
  GET  /api/v1/replay/sessions/:id
  GET  /api/v1/replay/sessions/:id/stream?after=<replaySeq>
  ```

  Creation requires `REPLAY_READY`; session events have only
  `(replaySessionId, replaySeq)` identity. They reuse ready artifacts but cannot
  create a notification intent, commentary job, Room call, reaction, or
  settlement.

- [ ] **Step 5: Rework profile/follow and Memory constraints.**

  Retain HttpOnly fan session/CSRF mechanics. The API creates an opaque fan ID,
  unique handle, avatar variant, favourite team, preferences and follows.
  Follows accept real followable fixtures only. A Memory exists only for a
  verified archive final; global history lists all verified finals, not just
  followed fixtures.

- [ ] **Step 6: Verify green and commit.**

  Run: `corepack pnpm exec vitest run apps/server/src/fixture-read-routes.test.ts apps/server/src/fixture-stream-routes.test.ts apps/server/src/replay-routes.test.ts apps/server/src/fan-routes.test.ts apps/server/src/memory-routes.test.ts`

  ```bash
  git add apps/server/src packages/db/src
  git commit -m "feat: serve durable fixtures history and recorded replay"
  ```

## Task 5: Build profile, truthful Today, and the real Match Hub PWA

**Files:**

- Add: `apps/web/src/features/onboarding/OnboardingFlow.tsx`
- Add: `apps/web/src/features/today/{TodayHub,FixtureCard}.tsx`
- Add: `apps/web/src/features/fixture/{MatchHub,fixture-stream}.ts`
- Add: `apps/web/src/routes/AppRouter.tsx`
- Modify: `apps/web/src/{App,live-api,product-state,fan-profile}.ts*`
- Modify: `apps/web/src/features/fan/{FanSurfaces,fan-surfaces.css}.tsx`
- Modify: `apps/web/src/components/{TeamFlag,team-flag.css}.tsx`
- Test: focused tests beside every new module

- [ ] **Step 1: Write failing UI tests.**

  ```tsx
  expect(
    render(<OnboardingFlow />).getByText("Who do you support?"),
  ).toBeVisible();
  expect(
    render(<TodayHub fixtures={[verifiedFinal]} />).getByText(
      "Verified finals",
    ),
  ).toBeVisible();
  expect(
    render(<TodayHub fixtures={[unavailableFixture]} />).queryByText(
      unavailableFixture.home.name,
    ),
  ).toBeNull();
  ```

- [ ] **Step 2: Verify red.**

  Run: `corepack pnpm exec vitest run apps/web/src/features/onboarding apps/web/src/features/today apps/web/src/features/fixture`

- [ ] **Step 3: Replace public synthetic flow.**

  Onboarding is exactly: 3–5 second skippable intro → favourite team → unique
  handle → team-themed avatar → Today. It uses `TeamFlag` everywhere; no
  circular tokens. Remove `demo`, `experience`, synthetic sample Moment, and
  localStorage-created match/history fallbacks from public routes.

- [ ] **Step 4: Implement Today and Match Hub from server DTOs.**

  Today renders only `Live now`, `Upcoming`, and `Verified finals`. The Match
  Hub renders lifecycle/freshness, large score/minute/last event, follow/alert,
  listening, Room eligibility, expandable timeline, and explicit cached/offline
  state. `LIVE` renders only when API freshness says live.

- [ ] **Step 5: Implement ordered browser state.**

  `product-state.ts` stores `lastAppliedSeq`, applies only contiguous events,
  requests a reset snapshot on a gap, and suppresses cinema/audio when an event
  is `reconcile`, provisional, stale, or superseded.

- [ ] **Step 6: Verify green and commit.**

  Run: `corepack pnpm exec vitest run apps/web/src/features/onboarding apps/web/src/features/today apps/web/src/features/fixture apps/web/src/product-state.test.tsx apps/web/src/components/TeamFlag.test.tsx`

  ```bash
  git add apps/web/src
  git commit -m "feat: add truthful onboarding today and match companion"
  ```

## Task 6: Render revision-safe Moments, Memory, and Recorded Replay

**Files:**

- Add: `apps/web/src/features/moments/MomentController.tsx`
- Add: `apps/web/src/features/memory/MemorySurface.tsx`
- Add: `apps/web/src/features/replay/{RecordedReplayLibrary,RecordedReplayScreen}.tsx`
- Modify: `apps/web/src/features/moments/{HonestMoments,types}.tsx`
- Modify: `apps/web/src/{memory-api,memory-loader,memory-view,MemorySourceNotice}.ts*`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/features/{moments,memory,replay}/*.test.tsx`

- [ ] **Step 1: Write failing Moment/replay tests.**

  ```tsx
  expect(
    render(<MomentController event={varGoal} />).getByText("UNDER REVIEW"),
  ).toBeVisible();
  expect(
    render(<MomentController event={overturned} />).getByText(
      "No goal — overturned.",
    ),
  ).toBeVisible();
  expect(
    render(<RecordedReplayScreen session={session} />).queryByText(
      "Create Room",
    ),
  ).toBeNull();
  ```

- [ ] **Step 2: Verify red.**

  Run: `corepack pnpm exec vitest run apps/web/src/features/moments apps/web/src/features/memory apps/web/src/features/replay`

- [ ] **Step 3: Implement Moment family/revision resolution.**

  The screen paints factual score/event state first. A VAR starts anticipation
  but no celebration; `stands` releases one short confirmation; `overturned`
  replaces the held state and explains the revision. Yellow cards use yellow,
  red cards red, VAR amber, and goals the selected team palette. A stale
  notification resolves current truth and labels the requested revision as
  superseded.

- [ ] **Step 4: Implement verified Memory and recorded replay surfaces.**

  Memory consumes only archive-verified API data. Replay is visibly `RECORDED
· TXLINE DATA`, uses session-local replay sequence, has no push/Room controls,
  and reuses ready factual audio artifacts only. If an archive is invalidated,
  hide the action rather than render a blank card.

- [ ] **Step 5: Verify green and commit.**

  Run: `corepack pnpm exec vitest run apps/web/src/features/moments apps/web/src/features/memory apps/web/src/features/replay apps/web/src/memory-loader.test.ts`

  ```bash
  git add apps/web/src
  git commit -m "feat: add revision-safe moments memory and recorded replay"
  ```

## Task 7: Deliver durable commentary, Listening Mode, and Push activation

**Files:**

- Add: `apps/server/src/commentary-job-worker.ts`
- Add: `apps/web/src/features/listening/ListeningControl.tsx`
- Add: `apps/web/src/features/push/{PushSetupSheet,activation-store}.ts*`
- Modify: `apps/server/src/{collector-main,durable-push,push-delivery}.ts`
- Modify: `apps/web/src/{ListeningProvider,push-notifications,notification-activation,main}.ts*`
- Modify: `apps/web/public/{sw,push-notification}.js`
- Test: `apps/server/src/commentary-job-worker.test.ts`
- Test: `apps/web/src/{ListeningProvider,push-notifications,notification-activation}.test.tsx`

- [ ] **Step 1: Write failing durable delivery tests.**

  ```ts
  expect(await jobs.enqueue(goalRevision)).toMatchObject({ status: "queued" });
  expect(await listener.deliver(goalRevision)).toEqual({
    cue: "sent",
    speech: "queued",
  });
  expect(pushPayload.tag).toBe(`matchsense:${fixtureId}:${familyId}`);
  expect(testPushPayload.tag).toMatch(/^matchsense:test:/u);
  ```

- [ ] **Step 2: Verify red.**

  Run: `corepack pnpm exec vitest run apps/server/src/commentary-job-worker.test.ts apps/web/src/ListeningProvider.test.tsx apps/web/src/push-notifications.test.ts apps/web/src/notification-activation.test.ts`

- [ ] **Step 3: Implement commentary worker and listener protocol.**

  A confirmed realtime narratable revision enqueues one shared job. The worker
  writes a factual transcript first, then TTS/FFmpeg MP3 bytes, hash and timing;
  it records failure without marking the artifact ready. Listening starts from a
  user gesture and exposes `Connecting`, `Listening`, `Speaking`, `Reconnecting`,
  `Audio blocked`, and `Stopped`. A listener receives immediate cue/text and
  speech only after attached stream + successful `play()` confirmation. Prior
  speech expires after 45 seconds; a correction supersedes unstarted audio.

- [ ] **Step 4: Implement PushPayloadV1 and service-worker activation.**

  ```ts
  type PushPayloadV1 = {
    schemaVersion: 1;
    intentId: string;
    fixtureId: string;
    familyId: string;
    revision: number;
    title: string;
    body: string;
    route: string;
    kind: "moment" | "test";
  };
  ```

  The worker creates intents only for realtime confirmed Moments. The service
  worker persists pending cold activation before `openWindow`; a warm click
  sends a route message and focuses without remounting the persistent audio root.
  Shell caching bypasses API, SSE, MP3, resolver and mutation routes. Do not use
  `skipWaiting` in an active Moment/listening session.

- [ ] **Step 5: Verify green and commit.**

  Run: `corepack pnpm exec vitest run apps/server/src/commentary-job-worker.test.ts apps/server/src/durable-push.test.ts apps/web/src/ListeningProvider.test.tsx apps/web/src/push-notifications.test.ts apps/web/src/notification-activation.test.ts`

  ```bash
  git add apps/server/src apps/web/src apps/web/public
  git commit -m "feat: add durable commentary listening and push activation"
  ```

## Task 8: Replace Rooms with data-qualified Call Three

**Files:**

- Modify: `packages/rooms/src/index.ts`
- Modify: `apps/server/src/{durable-room-service,durable-room-routes}.ts`
- Modify: `apps/web/src/features/rooms/{types,model,room-api,RoomExperience,rooms}.ts*`
- Test: `packages/rooms/test/rooms.test.ts`
- Test: `apps/server/src/durable-room-service.test.ts`
- Test: `apps/web/src/features/rooms/RoomExperience.test.tsx`

- [ ] **Step 1: Write failing Call Three tests.**

  ```ts
  expect(
    lockCalls({
      result: "home",
      goalsHigh: true,
      cardsHigh: false,
      confidence: [3, 2, 1],
    }),
  ).toMatchObject({ locked: true });
  expect(resolveCallThree(finalWithMissingCards)).toContainEqual(
    expect.objectContaining({ target: "cards", outcome: "void" }),
  );
  expect(createRoom(recordedFixture)).toThrow("ROOM_NOT_ELIGIBLE");
  ```

- [ ] **Step 2: Verify red.**

  Run: `corepack pnpm exec vitest run packages/rooms/test/rooms.test.ts apps/server/src/durable-room-service.test.ts apps/web/src/features/rooms/RoomExperience.test.tsx`

- [ ] **Step 3: Implement real-only Room state.**

  A Room may open only for an eligible real fixture. Calls lock at authentic
  kickoff and have exactly three targets: regulation result, total goals `>=3`,
  total cards `>=5`; each fan assigns confidence 3/2/1 exactly once. Correct
  calls earn confidence points, wrong zero, missing final facts void for all.
  Persist a non-transferable **MatchSense Points** lifetime total derived from
  settlements—never a wallet/balance/purchase/withdrawal flow.

- [ ] **Step 4: Implement controlled reactions.**

  `ROAR`, `COLD`, and `CALLED IT` reference confirmed Moment family/revision,
  are rate-limited by sender/recipient/event, are held during review, and are
  corrected if their event is overturned. No free text or prices/odds/corners.

- [ ] **Step 5: Verify green and commit.**

  Run: `corepack pnpm exec vitest run packages/rooms/test/rooms.test.ts apps/server/src/durable-room-service.test.ts apps/web/src/features/rooms/RoomExperience.test.tsx`

  ```bash
  git add packages/rooms apps/server/src apps/web/src/features/rooms
  git commit -m "feat: add real fixture Call Three rooms"
  ```

## Task 9: Retire synthetic public paths and polish supported devices

**Files:**

- Modify: `apps/server/src/{app,main,demo-routes,demo-runtime,experience-runtime}.ts`
- Modify: `apps/web/src/{App,live-api,styles}.ts*`
- Remove public imports of: `apps/web/src/features/demo/*`, `packages/replay/src/demo-timeline.ts`
- Modify: `apps/web/src/{manifest.webmanifest,public/sw.js}`
- Test: `apps/server/src/app.test.ts`, `apps/web/src/index.test.tsx`, `apps/web/src/mobile-layout.test.ts`

- [ ] **Step 1: Write failing public-scope tests.**

  ```ts
  expect(await app.inject("/api/v1/demo/session")).toMatchObject({
    statusCode: 404,
  });
  expect(await app.inject("/api/v1/experience/start")).toMatchObject({
    statusCode: 404,
  });
  expect(renderedHtml).not.toContain("Scripted Argentina");
  expect(renderedHtml).not.toContain("Sense allocation");
  ```

- [ ] **Step 2: Verify red.**

  Run: `corepack pnpm exec vitest run apps/server/src/app.test.ts apps/web/src/index.test.tsx apps/web/src/mobile-layout.test.ts`

- [ ] **Step 3: Remove public synthetic reachability and visual regressions.**

  Disable/delete public demo/Experience registrations and routes. Keep synthetic
  event fixtures only in test files. Audit all surfaces at 320, 375, 390, 412,
  768, 1024 and 1440 CSS pixels: no clipped card text, rectangular flags only,
  and semantic yellow/red/VAR/team colours. Empty state means no eligible data,
  never a fake match.

- [ ] **Step 4: Verify green and commit.**

  Run: `corepack pnpm exec vitest run apps/server/src/app.test.ts apps/web/src/index.test.tsx apps/web/src/mobile-layout.test.ts && corepack pnpm format:check`

  ```bash
  git add apps/server apps/web packages/replay
  git commit -m "feat: retire public synthetic MatchSense paths"
  ```

## Task 10: Integrate, deploy, and prove the end-to-end contract

**Files:**

- Add: `scripts/e2e-real-product.mts`
- Add: `scripts/e2e-recorded-replay.mts`
- Modify: `README.md`
- Modify: `../../HANDOFF.md`
- Modify: `railway.json`

- [ ] **Step 1: Write the browser contract before deployment.**

  The script uses two isolated browser contexts and proves:

  ```text
  guest profile -> follow real fixture -> truthful Today -> stream snapshot
  -> confirmed foreground Moment -> correction-safe resolver -> final Memory
  -> second fan joins real Room -> locked Call Three -> final leaderboard
  -> verified archive -> Recorded Replay -> no Room/push controls
  ```

- [ ] **Step 2: Run local full verification.**

  ```bash
  corepack pnpm test
  corepack pnpm typecheck
  corepack pnpm build
  corepack pnpm format:check
  corepack pnpm asset:check
  corepack pnpm test:container
  corepack pnpm exec tsx scripts/e2e-real-product.mts
  corepack pnpm exec tsx scripts/e2e-recorded-replay.mts
  ```

  Expected: every command exits `0`; no test substitutes synthetic public data.

- [ ] **Step 3: Deploy two Railway services and verify terminal success.**

  Deploy API and worker from the same revision. Verify API `/health/ready`,
  worker readiness/lease status, a single active source lease, an API restart
  retaining archive/history, and a worker restart retaining cursor/archive.

- [ ] **Step 4: Run the physical-device matrix.**

  Record actual PASS/FAIL—not inference—for iPhone Home Screen, Samsung tablet
  Chrome, and macOS Safari/Chrome: install, permission, foreground Moment,
  background/locked push, cold activation, audio start/pause/resume/interruption,
  reduced motion, and narrow-screen layout. A failed platform hides that claim;
  it does not block the truthful in-app product.

- [ ] **Step 5: Final review and handoff.**

  Update `HANDOFF.md` with deployed revision, service URLs, Gate A hashes,
  known device results, and any gated module. Commit documentation and push only
  after the deployment reaches Railway `SUCCESS`.

## Plan self-review

| Product requirement                           | Implemented by    |
| --------------------------------------------- | ----------------- |
| Live/recorded truth, no synthetic public data | Tasks 1–4, 9      |
| Global verified history and Match Memory      | Tasks 3, 4, 6     |
| Profile, favourite team, textured flags       | Task 5            |
| Live Companion, correction-safe Moments       | Tasks 4–6         |
| Cached factual audio and Listening fallback   | Task 7            |
| Standard push and exact activation            | Task 7            |
| Call Three, reactions, points-only            | Task 8            |
| Five-minute recorded walkthrough              | Tasks 3, 4, 6, 10 |
| Device/deployment evidence                    | Task 10           |

The plan contains no public synthetic fallback. Any unavailable provider or
platform capability has a remove/hide rule in the architecture rather than an
invented substitute.
