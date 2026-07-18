---
created: 2026-07-17
project: matchsense
ecosystem: full-stack
tags: [architecture, txline, pwa, railway, state-machines, evidence]
status: architecture-approved-gate-a-passed
---

# MatchSense Technical Architecture and Evidence Contract

[[10-Projects/Web3-Builds/Hackathons/MatchSense/HANDOFF]] | [[2026-07-17-unified-match-experience-design|Verified Match Experience Design]]

## 1. Decision and boundary

MatchSense ships as one installable PWA backed by two Railway services and one
PostgreSQL database:

```text
TxLINE schedule + historical recovery + scores SSE
                    │
                    ▼
          collector-worker (one leased owner)
 normalize -> canonical truth -> archive -> transactional outbox
                    │                         │
                    └──────── PostgreSQL ─────┘
                                   │
                                   ▼
                       api-pwa (one or more replicas)
       PWA shell / profile / rooms / browser SSE / push / audio stream
                                   │
                                   ▼
                         installed web applications
                 iPhone · iPad/Samsung tablet · macOS/Windows
```

The worker is the only component permitted to ingest TxLINE data, determine
fixture truth, generate commentary, or decide push eligibility. The API and
PWA can only read committed canonical data and create fan-owned mutations.

There are only two public data modes:

```ts
type ProductMode = "live" | "recorded";
type DataProvenance = "live_txline" | "recorded_txline_authorised";
```

`recorded` means an authorised, complete TxLINE-backed archive which passed
Gate A below. It powers the accelerated five-minute walkthrough. It is never
called live, cannot send historic pushes, and cannot open a Room. Synthetic
fixtures remain test-only and are not reachable in a deployed public route.

`recorded` is a read-only replay-session presentation namespace over the single
immutable live archive. A replay session has its own `replaySessionId` and
`replaySeq`; it never creates a second fixture projection, source delivery, or
browser SSE identity for the same TxLINE fixture.

This replaces the current deployment's coupled API/collector process,
process-local source ordering, elapsed-time final-status inference, and
synthetic Experience routes. — Source: `apps/server/src/main.ts`,
`packages/txline-adapter/src/live.ts`, `apps/web/src/live-api.ts`

## 2. Non-negotiable invariants

1. **The database commits truth before side effects.** An accepted
   truth-changing source delivery commits its projection, Moment revision,
   client event, and outbox rows in one transaction or none. A duplicate,
   rejected, quarantined, or no-visible-change delivery is retained with its
   diagnostic outcome but creates none of those derived rows.
2. **A past kickoff does not imply a final result.** Only an authoritative
   terminal TxLINE fact may mark a fixture final.
3. **Every user-visible event has a durable identity.** Score, Moment,
   notification, reaction, commentary, and replay reference the same fixture,
   event-family, and revision identity.
4. **Reconciliation is never presented as live.** It repairs truth and
   history, but cannot create a delayed goal celebration, push, teasing
   reaction, or spoken "just happened" update.
5. **The browser is a cache, never a historian.** It can show a labelled stale
   snapshot but cannot create a final result, Room settlement, or Memory.
6. **A PWA gets platform-standard notifications only.** It does not promise
   video/GIF cards, Dynamic Island, Live Activities, app-selected notification
   sound, or proof that the OS displayed an alert.
7. **No money semantics.** Rooms use non-transferable MatchSense Points only:
   no stake, token, wallet, purchase, withdrawal, payout, or global balance.

## 3. Service ownership and recovery

### 3.1 `collector-worker`

The worker starts with `ROLE=worker` and owns these loops:

- idempotent database migration/check guarded by a PostgreSQL advisory lock;
- bounded schedule refresh and covered-fixture discovery;
- historical backfill/reconciliation;
- a fenced singleton TxLINE SSE lease;
- normalisation, durable ingestion, reduction, archive verification;
- commentary job execution and durable artifact storage; and
- outbox consumers for source-derived work: product broadcast wakeups, push
  intents, commentary jobs, Room projection, and Memory finalisation.

Its source lifecycle is:

```text
STOPPED → LEASING → RECONCILING → STREAMING
                       │              │
                       ▼              ▼
                   DEGRADED   RECONNECT_BACKOFF
                       │              │
                       └───── LEASING ┘

UNAUTHORIZED → one credential-refresh attempt → LEASING
FORBIDDEN → CIRCUIT_OPEN (operator-visible; no hot retry loop)
CIRCUIT_OPEN → explicit operator reset after credential/data-rights repair → LEASING
FENCED → stop all writes and disconnect immediately
```

Schedule refresh has an independent state: `FRESH → STALE → EXPIRED`. A newer
schedule observation may adjust kickoff/participants only while a fixture is
`DISCOVERED` or `SCHEDULED`; `TRACKING`, `LIVE`, and terminal fixtures retain
their committed participants and canonical truth. A late schedule response
cannot demote a live/final fixture or overwrite a newer source timestamp.
`POSTPONED` returns to `SCHEDULED` only on a newer authoritative schedule;
`RESULT_UNAVAILABLE` returns to `TRACKING`, `LIVE`, or a terminal lifecycle
only when a newer authoritative result/history record is committed.

The worker acquires a durable source lease with a monotonically increasing
fencing token. Every write carrying source data verifies the token inside the
same database transaction. It advances an SSE cursor only after the whole
frame is durable. A restarted worker hydrates ordering and projections from
PostgreSQL, never a JavaScript map.

### 3.2 `api-pwa`

The API starts with `ROLE=api`. It serves the built web application and owns:

- anonymous fan/session/profile APIs;
- fixture list, current snapshot, archive, Moment, Memory, and Room APIs;
- browser Server-Sent Events (SSE) backed by the durable event log;
- Web Push registration, notification resolution, and delivery status views;
- listener-session control and the persistent MP3 transport; and
- static PWA files, service worker, offline shell, and health endpoints.

The API has no TxLINE credential and cannot reduce a source payload. It may use
PostgreSQL `LISTEN/NOTIFY` as a wake-up optimisation only. On a missed notify,
restart, or an API replica change, it queries the durable event log from the
client cursor. Every open fixture stream also has an API-side `lastSentSeq`, a
15-second heartbeat, and a five-second durable-log catch-up poll; a missed
database notify can therefore delay an event but cannot strand a client marked
live forever.

### 3.3 PostgreSQL

PostgreSQL is the product's durable truth, queue, archive, and audio cache.
Existing `commentary_artifacts.bytes` is retained for ready compressed audio;
the new job state lives separately so an absent or failed artifact cannot look
ready. Railway's local container filesystem is never used for durable match or
audio state.

The existing 500 MB Railway Postgres volume is enough for a measured hackathon
archive only if artifacts are short, compressed, and bounded. Commentary uses
one neutral factual artifact per narratable event revision, at 32 kbps MP3
after transcoding. The worker records bytes per artifact and fails the archive
health check before storage reaches 80% of the available volume. If the
measured archive would exceed that bound, audio retention is reduced to
verified key Moments; source truth and text history remain complete.

## 4. Durable data model

The implementation extends the existing durable tables instead of rewriting
the whole database. Names below are logical contracts; migrations make their
constraints explicit.

| Entity                                                           | Purpose and identity                                                                                                                                   | Required invariant                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures` + `fixture_schedule_observations`                     | source fixture ID, teams, kickoff, source timestamp, lifecycle and coverage                                                                            | schedule can update schedule fields only; it cannot set a score or `FINAL`                                                                         |
| `rights_grants`                                                  | private evidence reference, scopes, retention expiry and revocation state                                                                              | ingestion fails closed unless the required `live_display`, `normalised_retention`, `raw_retention`, `replay`, `audio`, or `fanout` scope is active |
| `source_deliveries` (current raw record foundation)              | immutable ordered source envelope; `delivery_key` is a non-null SHA-256 of source, stream, fixture, source id/sequence/frame ordinal, and payload hash | carries non-null `deliveryIntent: realtime                                                                                                         | reconcile`, immutable `orderingKey`, rights grant id, and explicit raw retention (`authorised_raw`or`normalised_only`) |
| `canonical_event_families`                                       | stable event-family key, kind, fixture and causal links                                                                                                | a family owns many append-only revisions, never mutates history                                                                                    |
| `canonical_event_revisions` (current Moment revision foundation) | family revision, status, source delivery, `supersedes/overturns` references                                                                            | revision is monotonically increasing per family and can only point to the same fixture                                                             |
| `fixture_projections` + `fixture_events`                         | current canonical snapshot and strictly increasing fixture `seq` for clients                                                                           | carries source delivery intent; a `seq` has one payload forever and a client can replay from it                                                    |
| `archive_manifests`                                              | ordered delivery ids, reducer version, projection hash, finalisation evidence, rights reference                                                        | a replay is publishable only when its manifest verifies                                                                                            |
| `outbox` + `consumer_receipts` + dead letters                    | at-least-once side effect queue                                                                                                                        | external work is idempotent by consumer receipt, never by in-memory flags                                                                          |
| `commentary_jobs` + `commentary_artifacts`                       | transcript/job status plus ready compressed bytes                                                                                                      | artifact key is `(fixture, family, revision, language, voice, templateVersion)`                                                                    |
| `notification_intents` + `push_deliveries`                       | fan/device-specific intent, provider result and endpoint state                                                                                         | provider acceptance is not claimed as seen/read/sounded                                                                                            |
| `listening_sessions` + `listening_deliveries`                    | fan, fixture, preference, attach/play state, expiry, and per-session ordered cue/speech delivery                                                       | unique `(session, fixtureSeq, deliveryKind, artifactKey)` rows track `queued`, `sent`, `started`, `skipped`, `superseded` or `expired`             |
| `room_calls`, `room_reactions`, `room_settlements`               | immutable locked calls, confirmed-Moment reactions, versioned scoring                                                                                  | settlement key is `(room, finalProjectionRevision, rulesetVersion)`                                                                                |

Five identities remain distinct:

```text
source delivery key       = physical provider delivery dedupe
event-family key          = one football action across amendments
Moment revision           = exact visible version of that action
fixture projection seq    = exact browser catch-up sequence
room settlement key       = one scoring result for one final projection
```

The `deliveryIntent` propagates from a source delivery through family revision,
fixture event, and outbox payload. Only `realtime` can create push, cinema,
commentary, or Room-reaction intents; `reconcile` is truth/history-only by
construction. Recorded replay uses separate session-local envelopes keyed by
`(replaySessionId, replaySeq)` and never enters source delivery, canonical
reduction, or the source-derived outbox path.

## 5. Canonical state machines

### 5.1 Fixture and archive

```text
DISCOVERED → SCHEDULED → TRACKING → LIVE → TERMINAL_FACT_COMMITTED
                                              │
                                              ├──→ Room settlement at projection revision R
                                              └──→ archive verification
                                                     │
                                                     ▼
                                                   FINAL
                                                     │
                                                     └── correction → FINAL_REVISED
                                                                          │
                                                                          ├── replay manifest invalidated
                                                                          ├── recalculated Room settlement R+1
                                                                          └── archive re-verification → FINAL

ARCHIVE: COLLECTING → TERMINAL_OBSERVED → REBUILT → VERIFIED → REPLAY_READY

Side states: POSTPONED · CANCELLED · RESULT_UNAVAILABLE · REPLAY_REJECTED
```

- `TERMINAL_FACT_COMMITTED`, archive verification, and Room settlement are
  distinct states. A Room may settle from an authoritative terminal projection;
  a Recorded Replay requires the stricter verified archive manifest.
- Schedule updates can create `DISCOVERED`, `SCHEDULED`, `POSTPONED`, or
  `CANCELLED`; only a canonical score event can enter `LIVE`; only an
  authoritative terminal fact can enter `TERMINAL_FACT_COMMITTED`; only archive
  verification can enter `FINAL`.
- `RESULT_UNAVAILABLE` and `REPLAY_REJECTED` are internal diagnostic states.
  The fan UI omits them rather than showing false `0–0 FT`, blank Memories, or
  unusable cards.
- `FINAL_REVISED` recalculates derived Room and Memory views with a new
  projection revision; it never silently overwrites the previous result. It
  returns to `FINAL` only after a new verified archive manifest exists. While
  re-verification is pending, `REPLAY_READY` becomes `REPLAY_INVALIDATED` and
  the old replay/Memory audio manifest is not served.

### 5.2 Source delivery and Moment family

```text
OBSERVED → NORMALISED → APPLIED_NO_VISIBLE_CHANGE
                 │
                 ├→ REJECTED | QUARANTINED
                 └→ FAMILY_REVISION
                       ├→ CONFIRMED → CORRECTED | SUPERSEDED
                       └→ PROVISIONAL → UNDER_REVIEW → CONFIRMED | OVERTURNED
                                                        └→ CORRECTED | SUPERSEDED
```

The reducer accepts a provider action only after schema validation. It stores
the immutable delivery first, finds/creates an event family, then derives a
new projection. A revision may be visible but only `CONFIRMED` may trigger a
celebration, standard push, Room reaction, commentary job, or final scoring.
When provider linkage for a VAR/correction cannot be proven, the UI shows a
factual snapshot correction and the unlinked rich Moment is suppressed.

### 5.3 Browser SSE and Moments

```text
snapshot(seq N) → contiguous live events → LIVE
       │                 │
       ├─ visibility/offline/gap/out-of-order ─→ STALE
       │                                         │
       └────────────────── authoritative snapshot + replay ─→ LIVE
```

Each SSE event id is `<fixtureId>:<seq>`. The initial or explicit reconnect URL
is `/api/v1/fixtures/:id/stream?after=<lastAppliedSeq>`; `after` must be a
non-negative integer. A valid native `Last-Event-ID` for the same fixture takes
precedence on automatic EventSource reconnect. A malformed, wrong-fixture, or
ahead-of-server cursor produces a `reset` snapshot instead of a partial stream.
The API reads the snapshot and events after its sequence inside one
repeatable-read boundary, sends the snapshot first, then increments. The client
applies an increment only if `seq === lastSeq + 1`; otherwise it freezes
cinema/audio, fetches an authoritative snapshot, updates the cursor atomically,
and resumes. Reconciliation data updates truth but never plays a past goal
animation.

A Moment deep link is:

```text
/matches/:fixtureId/moments/:familyId?revision=:momentRevision&notification=:opaqueIntentId
```

`familyId` is stable for the football action; `revision` is the exact immutable
visible version. The URL is only a hint. The API resolves it against the
current fan session:
`current`, `superseded`, `expired`, or `offline-cached`. It renders the factual
score first; animation and celebration run only after the requested revision is
still confirmed and current. A superseded goal opens the correction, never the
old celebration. The service worker validates a same-origin allowlisted route,
persists a short-lived pending activation before cold `openWindow`, and uses
`postMessage + focus` for a warm client without remounting the audio root. At
bootstrap, the PWA consumes the one-shot activation record if iOS opens the
root rather than the exact URL.

### 5.4 Push

```text
eligible confirmed realtime Moment
  → notification intent → provider attempt → sent | failed | endpoint_invalid
  → OS display (unobservable) → warm/cold tap → server resolver → exact Moment
```

Only real-time delivery intent is push eligible. Historical replay,
reconciliation, stale catch-up, provisional VAR, and replay runs cannot push.
`410`/`404` invalidates a device subscription. `sent` means the provider
accepted it; it never means a lock screen appeared, a sound played, or the fan
read it. iPhone/iPad permission is requested only from an installed Home Screen
app and a direct fan tap. macOS and Android use feature detection and their own
tested capability state rather than the iOS install rule. The service worker
handles `pushsubscriptionchange`; the app also rechecks permission/subscription
on visibility return, replacing a device record when the endpoint changes. —
Source: [WebKit Web Push for Home Screen Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [WebKit Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)

The server-to-service-worker payload is versioned and factual:

```ts
type PushPayloadV1 = {
  schemaVersion: 1;
  intentId: string; // opaque, fan-authorized resolver key
  fixtureId: string;
  familyId: string;
  momentRevision: number;
  title: string;
  body: string;
  route: string; // same-origin, allowlisted Moment route
  tag: `matchsense:${string}:${string}`; // fixture + family
  ttlSeconds: 90;
  kind: "moment" | "correction" | "test";
};
```

Goals/cards/final use their family tag. A correction gets a new opaque intent
but uses the same family tag and `renotify: true`, so platforms which honour
tags replace the prior visible alert with an explicit correction rather than
showing a conflicting second football fact. A test alert uses its own `test`
tag and cannot be mistaken for a live event.

### 5.5 Listening Mode and commentary

```text
IDLE → PREPARED → user gesture → CONNECTING
  → STREAM_ATTACHED + media.play() confirmed → LISTENING
  → cue queued → speech READY | FAILED | SUPERSEDED
  → PAUSED | RECONNECTING | STOPPED
```

The API does not create an active listener until both the server observes the
MP3 stream attach and the browser reports `audio.play()` success. It writes a
short connection cue before silence so "Start Listening" never appears inert.
The continuous stream can carry a static cue immediately; speech arrives when
the worker commits a ready artifact.

For every attached session, the API creates a durable cue delivery as soon as a
confirmed realtime Moment commits. A speech delivery is linked to the same
fixture sequence when its artifact becomes ready. Delivery order is canonical
fixture sequence, not TTS completion order. An earlier speech may wait at most
45 seconds; then it becomes `skipped_timeout` so it cannot block later speech.
An unstarted delivery becomes `superseded` when its Moment changes; a speech
already started is followed by the explicit factual correction cue/text. A
reconnect reads non-expired queued rows from the durable delivery ledger, so a
worker/API restart never silently revives an overturned goal or depends on an
in-memory audio hub.

```text
confirmed narratable Moment
→ commentary job (unique artifact key)
→ deterministic factual transcript
→ optional Groq phrasing within factual bounds
→ Gemini TTS
→ FFmpeg 32 kbps MP3
→ durable ready artifact
→ listeners by canonical sequence + replay/Memory reuse
```

Jobs are independently retryable with bounded concurrency and provider-aware
backoff; a slow goal cannot serialize every later event. A `429`, provider
failure, timeout, or transcode failure marks the job failed and emits the cue
plus factual text. It never publishes `commentary.ready` without bytes.
The shared artifact is neutral—not fan-specific—so one generation serves every
listener. Free API limits are variable by account and model; they are not an
availability promise. — Source: [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Groq rate limits](https://console.groq.com/docs/rate-limits)

No web architecture can guarantee exact-once audible playback across an OS
kill or network drop. The contract is: no duplicate canonical artifact is
queued during a healthy connection; after interruption the stream resumes from
the durable cursor; text truth remains complete; force-close becomes stopped.

Every audio trace records `eventReceivedAt`, `streamAttachedAt`,
`clientPlayConfirmedAt`, `audioEnqueuedAt`, `firstStreamByteAt`,
`artifactReadyAt`, and a skipped/superseded reason where applicable. These are
the evidence for latency and recovery; provider completion alone is not enough.

### 5.6 Profile, follow, and Room

```text
anonymous device → HttpOnly fan session → team + unique handle → profile ready
                                                └→ follows / device preferences

Room: DRAFT → OPEN → LOCKED(actual kickoff) → PROVISIONAL → SETTLED
             │             │                                  │
             ├→ INVITE_EXPIRED                                └→ RECALCULATING → SETTLED | VOIDED
             └→ CANCELLED / POSTPONED → NO_CONTEST
```

- The opaque `fanId` and secure session cookie identify a device-owned profile.
  The public handle is unique display identity, not authentication. Losing the
  browser session creates a new anonymous profile; no cross-device recovery is
  promised in v1.
- A Room invite is a random opaque secret, stored hashed. Joining needs a
  session and a nickname snapshot; no open chat, wallet, or third-party login.
- Calls are immutable after the server clock reaches the source kickoff. A
  late client receives a rejected mutation, even if its browser clock is wrong.
- A source-authoritative postponement/cancellation moves every `OPEN`, `LOCKED`,
  or `PROVISIONAL` Room for that fixture to `NO_CONTEST`, expires invitations,
  and awards no MatchSense Points.
- V1 has exactly three non-financial calls: regulation result, total regulation
  goals high/low, and total cards high/low. Ruleset v1 is fixed and stored with
  the Room: `result = home | draw | away`; goals `high` means **3 or more**;
  cards `high` means **5 or more**; equality belongs to high; cards include
  regulation plus extra time but exclude shootout; correct scores confidence
  points, wrong scores zero. Each member uses confidence 3, 2, 1 once.
- Target capability is determined from prior source validation at Room creation.
  Missing or unreliable final facts at settlement void that target for every
  member; the remaining targets retain their original confidence scoring.
- The final board persists in Room history. Profile may display a lifetime
  **MatchSense Points** total derived from Room settlements, but it is a
  read-only score, not a balance or token wallet.
- `ROAR`, `COLD`, and `CALLED IT` are rate-limited reactions against a
  confirmed Moment revision. They are blocked during review and labelled
  corrected if their target later changes.

## 6. Fan-facing availability rules

| Capability          | Inclusion rule                                                                                                                                   | Failure behavior                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Today / schedule    | known live, upcoming, or verified final fixture                                                                                                  | omit unavailable result rows; show an intentional empty state when no eligible fixtures exist |
| Live Companion      | healthy source + contiguous canonical snapshot                                                                                                   | show `CACHED · AS OF …`; suppress cinematic Moment and audio on a gap                         |
| Moment              | confirmed current revision                                                                                                                       | show factual correction/neutral state for stale or superseded deep link                       |
| Push                | iPhone/iPad: installed Home Screen PWA + supported + permission/device valid; macOS/Android: tested feature capability + permission/device valid | keep in-app updates; surface a repair action; never promise lock-screen delivery              |
| Listening           | user gesture + stream attach + `play()` confirmation                                                                                             | explicit blocked/paused/reconnect state; cue/text fallback on speech failure                  |
| Memory              | verified final archive manifest                                                                                                                  | no Memory action if the fixture lacks verified history                                        |
| Recorded Replay     | Gate A archive marked `REPLAY_READY`                                                                                                             | hide Replay completely, not a fabricated substitute                                           |
| Room                | real upcoming/live fixture and all v1 targets data-qualified                                                                                     | hide Create Room for that fixture; never simulate settlement                                  |
| Player/corner calls | authoritative player/card/corner final-data contracts                                                                                            | not in v1                                                                                     |

## 7. End-to-end flows

### 7.1 Real live match

```text
install → onboarding/profile → follow fixture → optional alert permission
→ Today/Match Hub → worker commits confirmed Moment
→ browser SSE truth + optional OS push + active listener cue
→ speech artifact if ready → full-time verification → Memory / Room settlement
```

The source event has one identity through every surface. If the fan is not
watching, the push gives factual text. If they tap, the PWA resolves truth
before it animates. If they are listening, the cue is immediate and factual
speech follows when ready. If the source later corrects the event, all surfaces
append the correction rather than silently changing history.

### 7.2 Recorded replay / judge walkthrough

```text
Replay library → verified archive manifest → five-minute paced timeline
→ same Live Companion, Moment, cue/speech, correction, final Memory
```

The worker creates the replay schedule from real retained occurrence order,
with an acceleration factor and a maximum inter-event delay. The API may emit
only session-local replay envelopes and pre-existing verified archive audio
artifacts. Replay never creates source deliveries, canonical truth, commentary
jobs, OS pushes, Room calls/reactions, or source-derived outbox work. It remains
visibly labelled `RECORDED REPLAY · TXLINE DATA`.

## 8. Evidence and test contract

### Automated evidence

- reducer and schema tests: duplicates, out-of-order input, amendments,
  corrections, missing-player fallback, and finalisation;
- PostgreSQL integration: transaction all-or-nothing, stale fence rejection,
  restart mid-frame, outbox lease/retry/DLQ, and deterministic re-ingestion;
- archive test: ordered deliveries produce identical event, projection, and
  manifest hashes across two clean databases;
- Room test: server-time lock, void target, final settlement, and final
  correction recalculation exactly once;
- API/SSE test: cursor catch-up, gap recovery, stale-age rendering, deep-link
  resolver, and no replay/reconciliation side effects;
- service worker test: warm/cold message routing, allowlisted deep link, denied
  permission, endpoint cleanup, and test-alert labelling;
- audio test: attach-before-dispatch, cue, queued artifact, failure fallback,
  supersession, reconnect cursor, and no ready-without-bytes;
- responsive browser tests: 320, 375, 390, 412, 768, 1024, and 1440 CSS pixels
  with no clipped card/event labels.

### Physical-device evidence

The following must be recorded as a matrix rather than inferred from browser
automation: iPhone Home Screen app, iPad Home Screen app, Samsung tablet
Chrome, macOS Safari web app/site, and Samsung Internet only if it is
advertised.

1. install, onboarding/profile persistence, relaunch;
2. permission granted, denied, later-disabled, and endpoint repair;
3. a labelled test alert for install/permission/activation **and separately**
   one confirmed real-time Moment push foregrounded, backgrounded, locked, and
   after PWA exit;
4. warm notification tap plus cold notification tap in both a terminated-PWA
   and service-worker/controller-evicted state on iPhone and iPad, resolving to
   current and superseded Moments;
5. network drop, two committed events, snapshot reconciliation, no duplicate
   cinema;
6. start listening, cue, speech/fallback, five minutes locked, pause/resume,
   media interruption, and force-close; and
7. offline/stale, reduced motion, accessibility labels, and narrow layout.

Browser automation can prove web contracts. It cannot prove OS lock screen,
Focus, sound, background audio, or device media behaviour.

The service worker precaches only a versioned application shell. Navigations
are network-first with shell fallback; API, SSE, MP3, notification resolver,
and Room mutations bypass caches. IndexedDB stores at most the last successful
fixture snapshot with `retrievedAt` and a source-age label. A new service worker
shows an update-ready control but does not `skipWaiting` into the middle of a
Moment or listening stream; reload is fan initiated after the active surface is
idle.

## 9. Gate A — historical replay spike

**Passed 2026-07-18.** The subscribed TxLINE historical endpoint returned two
byte-identical ordered responses for fixture `18237038`: `1,027` source
records, `154` canonical football records, `873` source-only records, and a
terminal `game_finalised` with `StatusId=100` at provider sequence `1026`.
The executable evidence and non-secret hashes are recorded in
[[10-Projects/Web3-Builds/Hackathons/MatchSense/validation/spike-results]].

The proof script passes only if:

1. two historical fetches produce the same stable fixture id, terminal
   authoritative fact linked to that fixture, source-owned total-order field,
   and identical ordered-delivery manifests: ordering key, ordinal, delivery
   key, and response hash; an observed documented revision rule is the only
   permitted exception and must be recorded in the manifest;
2. all truth-critical actions parse without an unresolved gap, while observed
   source-only lifecycle/coverage/telemetry records are retained in the source
   manifest and cannot create a canonical revision or fan-visible side effect;
   every archived row retains an immutable `orderingKey` and ordinal;
3. the archive stores response hashes, ordering proof, source headers/metadata,
   and an active private rights-grant reference without exposing credentials;
4. two clean reductions of the ordered archive produce identical canonical
   event/revision, projection, and manifest hashes;
5. re-ingestion produces zero new canonical outcomes. In the production store,
   that must entail zero new projection revisions, client events, outbox rows,
   commentary jobs, or Room settlements.

The observed provider terminal contract is `action=game_finalised`,
`statusId=100`, and `confirmed !== false`; `Confirmed` may be omitted. The
worker must not require an invented `Confirmed:true` flag to finalise a fixture.

Failure removes Recorded Replay, its judge walkthrough, and history audio from
the public scope. It does not downgrade to authored football data.

## 10. Build sequence after Gate A

1. Migrate contracts and database from public `demo`/synthetic data to
   `live`/`recorded` authoritative modes; retire public synthetic routes.
2. Split `ROLE=worker` from `ROLE=api`, add migration locking, leases, durable
   source ordering, schedule sync, archive/replay manifest, and canonical API.
3. Implement profile/follows/Today/Match Hub on the new API and add true
   cursor-based Companion/Moment rendering.
4. Implement durable commentary jobs and reliable Listening Mode with cue/text
   fallback, then add provider observability.
5. Implement push intent/resolver/device repair and service-worker activation.
6. Implement data-qualified Rooms, reactions, persisted MatchSense Points, and
   final Memory.
7. Add Recorded Replay only after Gate A, then run full automated/deployed/device
   evidence and polish responsive visual states.

This order gives a real usable path early: profile → current fixture → live
truth → Moment → final Memory. Push, audio, Rooms, and replay are then connected
to the same canonical contract rather than becoming separate simulations.
