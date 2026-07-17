---
created: 2026-07-17
project: matchsense
ecosystem: full-stack
tags:
  [
    design,
    architecture,
    pwa,
    txline,
    experience-match,
    rooms,
    notifications,
    commentary,
  ]
status: approved-pending-written-review
---

# MatchSense Unified Match Experience Design

[[10-Projects/Web3-Builds/Hackathons/MatchSense/specs/product-architecture|Product Architecture]] | [[10-Projects/Web3-Builds/Hackathons/MatchSense/ui-design/README|UI Design Preview]] | [[10-Projects/Web3-Builds/Hackathons/MatchSense/specs/api-contracts|API Contracts]]

## 1. Outcome

MatchSense is an installable PWA that turns a canonical football event into one coordinated fan experience across a foreground Moment, OS notification, continuous commentary stream, private Room, History, and Match Memory.

The product has three journeys backed by one engine:

| Journey          | Purpose                                                                        |                                              Rooms | Source                                  |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------: | --------------------------------------- |
| Guided Demo      | Five-minute solo proof of Moments, push, commentary, VAR, catch-up, and Memory |                                                 No | Synthetic TxLINE-shaped events          |
| Experience Match | Always-available complete accelerated match for solo or friend use             |                                                Yes | Synthetic TxLINE-shaped events          |
| Standard Match   | Real live fixture or authorised historical replay                              | Upcoming/live: yes; historical replay: no new Room | Live or authorised recorded TxLINE data |

The journeys differ only in source and guidance. They share canonical truth, routes, notifications, commentary, History, and Memory implementations. Experience and genuinely upcoming/live matches also share the Room implementation; a completed historical replay cannot open a new prediction Room because its outcome is already known.

## 2. Approved product decisions

- The first ordinary launch opens with a 3.5-second MatchSense animation. It is skippable, first-launch-only, reduced-motion safe, and bypassed by notification, Room, and Memory deep links.
- Onboarding creates an anonymous server session, then asks for favorite team, a case-insensitively unique public handle, and one team-themed avatar variant.
- A hidden immutable `fanId` owns data. The public handle may change without changing ownership.
- Avatars are generated from local team flag/textile assets, supporter symbols, handle initials, and an authored variant. There are no uploads.
- Rectangular textile flags appear in every visual team lockup: onboarding, fixtures, Companion, Moments, Rooms, Profile, History, and Memory.
- Demo Mode is solo and contains no Room demonstration.
- Experience Match is the permanent full-product fallback and supports Companion, push, lock-screen Listening Mode, Rooms, predictions, reactions, History, and Memory.
- New Rooms are available only for an Experience run before its kickoff or a real fixture before/live at its authentic kickoff. Historical replay never accepts new predictions.
- Sense is room-scoped confidence, not a token, wallet, prize, payout, or transferable balance.
- Real historical replay retains its actual teams and facts. A personalized opponent exists only in the explicitly labelled synthetic Experience Match.

## 3. Product lifecycle

```text
ONBOARD -> TODAY -> MATCH HUB -> LIVE COMPANION -> MOMENT -> MEMORY
                         \-> ROOM ------------------/
```

### 3.1 Onboarding

```text
first-launch animation
-> favorite-team selection
-> unique handle reservation
-> team-themed avatar selection
-> chosen-team sample Moment
-> contextual install and alert invitation
-> Today
```

The sample Moment is labelled replay or simulation and delivers value before permission prompts. Returning users land on Today. Direct links resolve their destination before onboarding; a new invite recipient completes only the minimum profile fields and returns to the invitation.

### 3.2 Today

Today contains five ordered sections:

1. `For You`: favorite team’s live or next fixture.
2. `Live Now`: currently active real fixtures.
3. `Upcoming`: chronological schedule.
4. `Experience Match`: a permanent, clearly labelled entry.
5. `Recent`: completed followed matches and Memories.

Primary navigation is `Today`, `Rooms`, and `You`. Rooms lists active invitations and memberships; You owns Profile and configuration.

### 3.3 Match Hub

Every fixture uses one shell:

```text
teams + textile flags
kickoff/status + provenance
score or pre-match state
--------------------------------
Follow / Tune alerts
Start Listening
Create or Join Room (Experience or eligible upcoming/live match only)
--------------------------------
Timeline / Room / Details
```

Following defaults to goals, red cards, and full-time. Permission and following are separate: the match remains followed if notifications are denied.

### 3.4 Experience Match

Solo flow:

```text
Play solo -> alert/listening check -> server countdown -> kickoff -> match -> Memory
```

Friend flow:

```text
Create Match Night -> share invite -> members join and make calls
-> host starts -> final 30-second countdown -> calls lock -> match -> leaderboard + Memory
```

The Room and match share one server-owned kickoff. An Experience run continues when every browser disconnects.

### 3.5 Guided Demo

Demo creates a temporary guided Experience run with Rooms disabled. It validates capability readiness and then demonstrates:

```text
foreground goal + commentary
-> instruction to lock/background device
-> real red-card Web Push
-> exact Moment activation
-> VAR review and overturn
-> deliberate disconnect with ordered catch-up
-> decisive event
-> full-time Memory
```

Its temporary fixture follow is removed when the run finishes. The final actions are `Play a full Experience Match` and `See the real schedule`.

## 4. Profile and identity

The profile contains:

- generated avatar, display name, and unique `@handle`;
- favorite team and followed teams/fixtures;
- alert event matrix;
- commentary language and voice;
- reduced-motion, contrast, captions, and screen-reader preferences;
- registered notification devices;
- Rooms played, wins, correct-call percentage, and streaks;
- account and data deletion.

Handle reservation uses a database uniqueness constraint on the normalized lowercase value. The server issues a secure HttpOnly session cookie. Local storage may cache non-authoritative presentation preferences but is never authentication.

Changing favorite team asks the fan to select a new avatar variant using that team’s theme. Account deletion removes devices, subscriptions, follows, preferences, and social ownership. Completed Room history keeps its aggregate result but replaces the deleted member’s identity with `Deleted fan`.

## 5. Room and Sense lifecycle

Each eligible participant receives exactly 100 Sense in each Room. They select one side in five fixed calls and distribute the 100 Sense as confidence:

1. 90-minute result.
2. Over/under 2.5 goals.
3. Over/under 4.5 cards.
4. Over/under 9.5 corners.
5. Both teams to score.

There are no prices, odds, multipliers, returns, purchases, transfers, withdrawals, or global Sense wallet.

Room states are:

```text
lobby -> calls open -> calls locked -> live/provisional -> final | void
```

- Picks remain private until kickoff.
- Members joining after kickoff are spectators.
- Experience hosts see member readiness before starting. Starting with unfinished members requires confirmation; unfinished slates receive no score. Real matches start at the authentic kickoff regardless of member readiness.
- Correct confidence contributes to the Room score; incorrect confidence contributes zero.
- The normalized final score is `100 * correct resolved confidence / total resolved confidence`.
- A call with unavailable or unreliable source statistics is void and excluded from both sides of the formula.
- If every call is void, the Room ends without a winner.
- Results persist in the Room, relevant Match Memory, and profile achievements. Sense itself does not persist beyond the Room.
- Reactions are limited to `ROAR`, `COLD`, and `CALLED IT`, reference a canonical Moment family/revision, and provide no open chat.
- Every Room call is explicitly regulation-time plus stoppage time. Extra-time and shootout events never change its five outcomes. The leaderboard remains provisional until `game_finalised` so corrections can reconcile first.

## 6. Runtime architecture

The hackathon deployment is a modular monolith:

```text
Railway Node service
|- built PWA and Fastify API
|- TxLINE ingestion
|- Experience scheduler
|- fixture processor
|- outbox consumers
|- Web Push
`- continuous MP3 streams

Railway PostgreSQL
|- canonical match truth
|- Experience state
|- profiles and follows
|- push and notification state
|- Rooms and results
`- commentary and Memories
```

The submission uses one application replica. Redis, a separate worker deployment, uploaded-media storage, and multi-replica scheduling are outside hackathon scope.

### 6.1 Journey and provenance

Journey and truth source are independent:

```ts
type Journey = "guided_demo" | "experience_match" | "standard_match";

type Provenance =
  "synthetic_txline_shaped" | "live_txline" | "recorded_txline_authorised";
```

Every consumer response contains exact provenance. Replay and simulation never claim `LIVE`.

### 6.2 Sources

Experience scheduler, TxLINE live ingestion, and authorised historical playback produce immutable source envelopes. A source cannot directly send a push, create commentary, score a Room, or mutate a client.

`ScheduleSync` refreshes at startup and on a bounded five-minute cadence, upserts every returned fixture, and tolerates absent optional schedule fields rather than discarding the fixture. It groups persisted fixtures into live, upcoming, and recent views. Historical score sequences are fetched only on demand; they are not downloaded for every completed fixture at boot.

Every source envelope declares a delivery intent:

```text
realtime  -> eligible for Moment, push, commentary, Room, and Memory work
reconcile -> rebuilds canonical truth/history without blasting old push or reaction side effects
```

Reconnect and startup history therefore repair projection state without announcing old goals as if they had just occurred.

### 6.3 Canonical transaction

Each source envelope is handled in one database transaction:

```text
deduplicate envelope
-> lock or optimistic-check fixture revision
-> run deterministic reducer
-> update fixture projection
-> append stable Moment revision
-> append reconnectable fixture event
-> enqueue downstream outbox jobs
```

Moment family IDs use a TxLINE action identity where verified, otherwise the immutable source transition identity; synthetic IDs use `experienceRunId + beatKey`. They are never derived from the score. Every fixture has one monotonically increasing revision.

### 6.4 Canonical event union

The minimum union is:

```text
phase.kickoff
goal
card.yellow
card.red
corner
penalty.awarded
penalty.scored
penalty.missed
var.started
var.stands
var.overturned
phase.half_time
phase.regulation_end
phase.extra_time_start
phase.extra_time_half
phase.shootout_start
shootout.kick_scored
shootout.kick_missed
phase.full_time
correction
```

Each event carries stable family ID, fixture revision, status, score/stat snapshot, source identity, occurrence/receipt times, and nullable explicitly sourced player identity.

The fixture projection stores regulation score, extra-time score, and shootout score separately and records whether the match was decided in regulation, extra time, or a shootout. A shootout kick is never counted as a normal goal or Room goal.

### 6.5 Experience scheduling

`ExperienceTemplate` stores an immutable scenario. `ExperienceRun` stores run/fixture IDs, owner, teams, journey, server kickoff, next beat, and status. A PostgreSQL scheduler claims due beats; uniqueness on `(runId, beatIndex)` makes retries safe. After restart, active runs continue from their persisted cursor.

### 6.6 Outbox consumers

Only committed canonical events drive:

- foreground SSE and catch-up;
- targeted push;
- commentary generation and multicast;
- Room projection and reactions;
- History and Memory.

Consumer receipts are recorded after successful idempotent side effects. Retry identity prevents a second Moment, Room score, or push candidate.

## 7. Moment, push, and commentary

### 7.1 Truth-first Moment

Fixture truth paints before animation, sound, sponsorship, or reactions. A VAR review holds celebration. `VAR stands` releases one celebration; `VAR overturned` appends a correction, rolls back score, and cancels held reactions/sponsor work.

### 7.2 Push targeting

Push subscriptions belong to a fan/device and are filtered by followed fixture/team and event preferences. A visible client may acknowledge foreground delivery during a short bounded window so the server can avoid sending an unnecessary push. If visibility is unknown, the reliable fallback is to send. Once WebKit receives a push, the service worker always shows a visible notification; suppressing a received push is forbidden by WebKit’s user-visible contract. — Source: [WebKit, Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)

An occasional foreground duplicate is acceptable; missing a locked-screen alert is not.

### 7.3 Notification activation

Warm activation focuses the existing client and sends a validated message for internal routing without reloading the root audio provider. Cold activation opens the exact route and also records a one-shot pending activation for iOS recovery.

The resolver returns requested revision, latest family revision, and current fixture truth. A stale goal alert resolves to the current overturned/revised state before any celebration.

iOS/iPadOS Web Push requires a Home Screen web app and a direct user interaction for permission. It can then display on the Lock Screen without Apple Developer Program membership. — Source: [WebKit, Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

### 7.4 Listening Mode

`Start Listening` is a direct user gesture that starts one persistent same-origin `<audio>` stream at the application root. Autoplay without user activation cannot be relied upon. — Source: [MDN, Autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)

Listening states are:

```text
idle -> prepared -> connecting -> listening <-> speaking
                              \-> paused -> reconnecting -> listening
                              \-> stopped
```

Route changes and warm notification taps preserve the element. Locking/backgrounding may preserve a user-started stream on verified devices; force-closing ends audio. The product does not claim audio after force-close.

### 7.5 Commentary

Canonical facts create deterministic factual copy. An optional bounded Groq clause may add atmosphere, then Gemini TTS creates a validated MP3. Raw TxLINE payloads never reach either model.

Cache key:

```text
moment family + revision + language + voice + relation(for/against/neutral)
```

One artifact serves all matching listeners. Demo/Experience commentary is prewarmed from the known scenario. Live truth and cue appear immediately; commentary may follow later. Failure falls back through deterministic TTS, event cue plus transcript, then factual visual state.

## 8. Persistence ownership

PostgreSQL owns:

- fans, handles, profiles, devices, preferences, and follows;
- fixtures, Experience templates/runs/beats, source records, projections, Moments/revisions, fixture events, and outbox;
- push subscriptions, notifications, and delivery receipts;
- commentary artifacts;
- Rooms, hashed invites, members, picks, reactions, and results;
- Match Memories and profile achievements.

Only live SSE clients, active audio response streams, presence acknowledgements, and in-flight generation promises remain process-local.

## 9. API surface

The implementation plan may refine payload schemas but must preserve these route families:

```text
POST   /api/v1/session/guest
GET    /api/v1/bootstrap
GET    /api/v1/profile
PUT    /api/v1/profile
POST   /api/v1/profile/handle-check
DELETE /api/v1/profile

GET    /api/v1/fixtures
GET    /api/v1/fixtures/:fixtureId
GET    /api/v1/fixtures/:fixtureId/stream
GET    /api/v1/fixtures/:fixtureId/moments/:identity
PUT    /api/v1/follows/:fixtureId
DELETE /api/v1/follows/:fixtureId

POST   /api/v1/experience-runs
POST   /api/v1/experience-runs/:runId/start
GET    /api/v1/experience-runs/:runId

POST   /api/v1/push/subscriptions
DELETE /api/v1/push/subscriptions/:deviceId
POST   /api/v1/push/test
POST   /api/v1/moments/:identity/foreground-ack

POST   /api/v1/fixtures/:fixtureId/listening-sessions
GET    /api/v1/listening-sessions/:sessionId/stream.mp3
DELETE /api/v1/listening-sessions/:sessionId

POST   /api/v1/rooms
GET    /api/v1/rooms
GET    /api/v1/rooms/invites/:inviteCode/preview
POST   /api/v1/rooms/join
GET    /api/v1/rooms/:roomId
PUT    /api/v1/rooms/:roomId/picks
POST   /api/v1/rooms/:roomId/start
POST   /api/v1/rooms/:roomId/reactions

GET    /api/v1/memories/:fixtureId
```

All mutations use server session identity, CSRF protection, strict input validation, and idempotency keys where retries are safe.

`POST /api/v1/rooms/:roomId/start` is valid only for a pre-kickoff Experience Room. Real fixtures always use their authentic server schedule, and historical replays reject Room creation.

## 10. Failure behavior

| Failure                | Required behavior                                          |
| ---------------------- | ---------------------------------------------------------- |
| TxLINE disconnect      | Remove `LIVE`, show exact age, reconcile before media      |
| Missed events          | Return one ordered catch-up packet                         |
| Duplicate input        | No duplicate truth, push, commentary, or Room result       |
| Railway restart        | Resume Experience cursor and outbox work                   |
| Database unavailable   | Fail readiness; PWA may show explicitly stale cached truth |
| Push denied            | Match remains complete; show non-looping recovery guidance |
| Push endpoint 404/410  | Invalidate device and resync on next launch                |
| TTS/model failure      | Preserve truth/push; use cue/transcript fallback           |
| Audio break            | Reconnecting state; expose Resume if gesture is required   |
| VAR overturn           | Roll back truth; cancel held celebration/reaction/sponsor  |
| Missing Room stat      | Void only the affected call and normalize score            |
| Historical unavailable | Hide replay action; retain Experience Match                |
| Missing player data    | Team-only presentation; no player-specific call            |

## 11. Security, rights, and assets

- Secure HttpOnly SameSite guest session and CSRF protection.
- Case-insensitive handle uniqueness.
- Hashed, expiring Room invite secrets.
- Encrypted push endpoint/key material and redacted logs.
- Same-origin allowlisted notification navigation.
- No wallet, payment, global Sense balance, or transferable reward.
- No raw TxLINE payload or credential in the browser or model prompt.
- Synthetic Demo and Experience remain available independently of TxLINE.
- Live-derived retention uses the configured hackathon rights mode and a bounded policy.
- Permanent recorded replay remains disabled until TxODDS authorizes retention and replay. TxLINE’s hackathon data licence prohibits redistribution and terminates with the event. — Source: [TxODDS World Cup Hackathon Terms, section 7](https://txline.txodds.com/documentation/legal/hackathon-terms)
- Flags, fonts, sounds, and motion assets are recorded in an asset-rights manifest. FIFA marks, official tournament branding, player photos, and real sponsor assets require separate permission. — Source: [TxODDS World Cup Hackathon Terms, section 6](https://txline.txodds.com/documentation/legal/hackathon-terms)

## 12. Scope boundary

Included:

- complete anonymous identity/Profile lifecycle;
- all three journeys;
- durable Experience scheduling and canonical truth;
- foreground Moments, targeted Web Push, exact activation;
- verified lock-screen Listening behavior with honest platform fallbacks;
- persistent Rooms and room-scoped 100 Sense;
- History and revisioned Memory;
- real schedule/live ingestion and gated historical replay;
- premium textile flags, generated avatars, and corrected Room forms.

Excluded:

- native iOS/Android apps, Dynamic Island, or Live Activities;
- uploaded avatars, player-photo dependency, or official tournament marks;
- global friend graph, open chat, public leaderboard, or global Sense wallet;
- money, prizes, odds, pricing, wallet, or settlement;
- Redis, object storage, multiple application replicas, and exhaustive post-hackathon scale hardening.

## 13. Implementation order

1. Generalize canonical contracts and migrations; add server guest identity/Profile.
2. Connect the durable fixture processor, event log, outbox, and exact Moment resolver.
3. Build the PostgreSQL Experience scheduler and one goal through foreground SSE, targeted push, exact activation, and commentary.
4. Extend the reducer to cards, penalties, VAR, phases, corrections, and aggregate Room statistics.
5. Complete first-launch animation, team flags, handle/avatar onboarding, Profile, Today, and unified Match Hub.
6. Persist Rooms, the five-call 100-Sense confidence lifecycle, reactions, final result, and Profile achievements.
7. Replace the isolated demo with a guided controller over a real Experience run.
8. Expand the schedule and map live TxLINE envelopes into the same fixture processor.
9. Generate History/Memory and enable authorised on-demand historical replay when rights permit.
10. Run one focused integration, build, Railway deployment, and physical-device acceptance gate.

Visual work on the intro, flags, avatars, Profile, and Room form may run in parallel. The event contract, reducer, fixture processor, and shared integration files remain one coordinated lane.

## 14. Verification boundary

Required automated proof:

- canonical goal/card/penalty/VAR/phase/correction transitions;
- stable identity and duplicate/revision handling;
- scheduler restart and atomic projection/outbox commit;
- targeted push, stale notification resolution, and warm activation without audio teardown;
- handle uniqueness and session ownership;
- Room lock, void, normalized scoring, persistence, and final Memory result;
- commentary cache/fallback and no raw source leakage;
- one browser journey from onboarding through Experience Memory;
- monorepo typecheck and production build.

Required physical proof:

- iPhone Home Screen PWA: permission, foreground Moment, locked push, cold/warm exact activation, continuous commentary, pause/resume;
- Samsung Chrome PWA: background/closed-PWA push, locked audio, and two-device Room;
- macOS installed PWA: notification activation and minimized Listening Mode.

Load testing, multi-replica races, exhaustive browser-version matrices, and long soak testing are post-submission work unless they block the required journey.

## 15. Completion contract

The deployed product is complete only when one real run proves:

```text
first-launch animation
-> favorite team + unique handle + team avatar
-> Today
-> Experience Match
-> follow + alerts
-> Start Listening
-> create/join Room on a second device
-> lock room-scoped 100 Sense
-> foreground Moment
-> locked-phone notification and commentary
-> exact notification activation
-> VAR correction
-> Room final result
-> Match Memory
-> Profile achievement
```

Guided Demo separately proves the solo Moment/push/commentary/correction/catch-up flow without Rooms. A real TxLINE fixture proves the same canonical processor accepts the sponsor’s live source.
