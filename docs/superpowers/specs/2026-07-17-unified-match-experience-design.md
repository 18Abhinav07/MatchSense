---
created: 2026-07-17
last-updated: 2026-07-17
project: matchsense
ecosystem: full-stack
tags: [design, architecture, pwa, txline, verified-data, replay, rooms]
status: approved-pending-written-review
---

# MatchSense Verified Match Experience Design

[[10-Projects/Web3-Builds/Hackathons/MatchSense/specs/product-architecture|Product Architecture]] | [[10-Projects/Web3-Builds/Hackathons/MatchSense/specs/api-contracts|API Contracts]] | [[10-Projects/Web3-Builds/Hackathons/MatchSense/ui-design/FULL-PRODUCT-FLOW|Product Flow]]

## 1. Product decision

MatchSense is an installable PWA for following **real TxLINE-backed football
matches** when a fan cannot watch. It turns a confirmed match update into a
Live Companion update, an in-app Moment, an optional standard Web Push alert,
and an optional factual Listening Mode update.

There is no user-facing synthetic match feed. There are only two data
provenances:

```ts
type Provenance = "live_txline" | "recorded_txline_authorised";
```

- `live_txline` is a currently covered fixture whose canonical state derives
  from TxLINE schedule, historical reconciliation, and scores SSE data.
- `recorded_txline_authorised` is a complete, retained, ordered TxLINE event
  timeline that passed the replay gate in section 8.

A five-minute judge walkthrough is an accelerated **Recorded Replay**, never a
synthetic simulation. A replay is labelled `RECORDED REPLAY · TXLINE DATA` at
all times and cannot create new predictions or masquerade as a current match.

## 2. Product promise and non-goals

### Promise

```text
Pick a team -> follow a real match -> receive factual match updates
-> open the exact Moment -> review a verified final Memory.
```

Every consumer sees the same canonical event identity and revision. Personal
preferences change tone, motion, and the next action; they never change score,
minute, event type, or final outcome.

### Explicit non-goals

- No fabricated schedules, historic results, player identities, or event data.
- No client-side inference that an old kickoff means full-time.
- No money, odds, wagering, transferable token, global wallet, prize, payout,
  or "bet" terminology.
- No native-only Dynamic Island, Live Activity, rich video notification, or
  custom notification-card UI.
- No fictional sponsor placement or third-party ad masquerading as a real
  commercial relationship.
- No player-photo or player-call feature until an authoritative identity map is
  proven available.

## 3. Truth and lifecycle contract

The server is the sole authority for a fixture lifecycle:

```ts
type FixtureLifecycle =
  | "scheduled"
  | "live"
  | "final"
  | "result_unavailable";
```

- A schedule record can establish fixture identity, participants, and kickoff;
  it cannot establish score or full-time.
- Only a canonical terminal result (`game_finalised` or an equally authoritative
  completed score record captured by the adapter) can produce `final`.
- If a match is in the past but TxLINE has not supplied sufficient result data,
  the product displays `RESULT UNAVAILABLE`, not `0–0 FT`.
- A reconnect or historical recovery rebuilds truth but never sends delayed
  goal pushes, celebrations, or social reactions as if the event just happened.
- VAR/amendment/correction always appends a revision. It never silently rewrites
  a prior Moment.

TxLINE documents fixture snapshots, score snapshots, updates, a scores SSE
stream, and a historical-score endpoint; historical replay must still be
empirically validated against the subscribed account and a completed fixture.
— Source: [TxLINE Fetching Snapshots](https://txline.txodds.com/documentation/examples/fetching-snapshots), [TxLINE Streaming Data](https://txline.txodds.com/documentation/examples/streaming-data)

## 4. Fan journeys

### 4.1 First launch and profile

```text
first-launch MatchSense motion (3–5 seconds, skippable)
-> choose a favourite team
-> choose a unique public handle and team-themed local avatar
-> see Today
-> choose alert preferences when a follow action makes that useful
```

The server creates an opaque `fanId` and secure device session. The public
handle is unique but is not the authority for ownership. A profile contains the
avatar, favourite team, follow preferences, accessibility preferences, and Room
history. It intentionally does not promise cross-device account recovery until
an explicit account system exists.

Team presentation uses one reusable 3:2 rectangular textile flag component.
It is used on onboarding, fixtures, Moments, Rooms, Profile, History, and
Memory. No circular flag-token alternative may appear.

### 4.2 Today and real match flow

```text
Today
-> Live now | Upcoming | Verified finals | Result unavailable
-> Match Hub
-> Follow / alert preference / Start Listening / eligible Room
-> Live Companion
-> confirmed Moment
-> canonical final
-> Match Memory
```

The Match Hub always shows source freshness and lifecycle. `LIVE` is earned
only after a healthy reconciled source stream; cached state shows an exact age.

### 4.3 Recorded Replay and judge walkthrough

```text
Recorded Replay library
-> choose a verified completed fixture
-> accelerated five-minute replay
-> goal, card, VAR, correction, full-time, Memory
```

The replay uses the exact retained canonical event ordering. It can show the
same foreground Moment, timeline, factual audio, and Memory as live data, but:

- it never calls itself live;
- it never sends a historic event as a live push; and
- it does not permit new Room calls because the outcome is known.

A separate, user-initiated `Test alert` confirms installation and notification
permission. It is labelled as a test and is not a football event.

### 4.4 Match Memory

A Memory exists only for a canonical final fixture. It shows the actual result,
ordered key Moments, revision/correction context, source provenance, and a
shareable factual summary. If no verified timeline exists, the Memory action is
absent rather than opening an empty replay.

## 5. Live Companion, Moments, push, and Listening Mode

### 5.1 Moment rules

Canonical score and event type paint before animation, audio, reaction, or
optional commercial surface. A VAR review holds celebration; `stands` releases
it once; `overturned` replaces it with an explicit corrected Moment.

Cards are semantically coloured: yellow card is yellow, red card is red, VAR
is amber, and goal treatments use the followed team's actual palette. Every
surface must work at 320, 375, 390, 412, 768, 1024, and 1440 CSS pixels without
clipped labels.

### 5.2 Push contract

Push is a standard Web Push notification carrying factual text and an exact
Moment deep link. A fan must install the PWA, explicitly grant permission, and
enable the relevant event preference. iOS/iPadOS Home Screen web apps support
this Web Push path and Lock Screen delivery; Focus and device notification
settings remain fan-controlled. — Source: [WebKit Web Push for Home Screen Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

The PWA does not promise custom notification layout, GIF/video playback,
Dynamic Island, or app-selected notification sound. Rich notification images
have limited browser support. — Source: [MDN Notification image](https://developer.mozilla.org/en-US/docs/Web/API/Notification/image)

Push only represents real live events. If the device is unavailable, Focus is
enabled, or the endpoint is revoked, the app records provider delivery state
but never claims the fan saw or heard it.

### 5.3 Listening Mode

Listening Mode starts only through a direct user gesture. The listener contract
is:

```text
canonical event -> immediate distinct cue -> factual speech if audio is ready
```

An LLM may improve phrasing after canonical facts exist, but cannot decide or
invent match state. Each speech packet uses confirmed facts only. Slow packets
are dropped when stale rather than creating a misleading commentary backlog.

The UI exposes `Connecting`, `Listening`, `Speaking`, `Reconnecting`,
`Audio blocked`, and `Stopped`; it never silently shows a dead Start Listening
control. The server must confirm the media stream is attached before accepting
event audio for that session. Speech/TTS failure degrades to the immediate cue
and visible factual event.

Background/locked playback is an enhancement, not a contractual claim, until
the physical-device gate passes. A force-closed PWA never promises continued
audio.

## 6. Rooms: social, points-only, data-qualified

Rooms are a lightweight pre-match ritual for real upcoming/live fixtures only.
They are unavailable for historical replays.

```text
host chooses eligible real fixture -> shares invite
-> members join with durable anonymous fan IDs
-> Call Three locks at authentic kickoff
-> confirmed events update a provisional board
-> canonical final resolves the Room
```

`Call Three` is deliberately limited to source-qualified outcomes:

1. regulation-time result;
2. total goals high/low; and
3. total cards high/low.

Each fan assigns confidence values 3, 2, and 1 exactly once. Correct calls earn
their confidence value; wrong calls earn zero; unavailable stats void the call
for everyone. The Room retains its final score and leaderboard, but there is no
currency, wallet, balance, purchase, withdrawal, or transferable value.

Corners and player-to-score calls stay out of v1. Corners can return only after
the complete data/reconciliation path proves they survive finalization and
correction. Player calls require authoritative player identity mapping.

Fans can send `ROAR`, `COLD`, or `CALLED IT` against a confirmed Moment. This
is a durable in-Room reaction, not open chat. A recipient receives a Web Push
only if they are a Room member and enabled push; otherwise the reaction appears
on their next Room visit. Reactions never leave during VAR review and are
marked corrected if the underlying event changes.

## 7. Server ownership and persistence

The Railway service and PostgreSQL own all product truth:

```text
TxLINE schedule / historical recovery / SSE
-> normalized source fact
-> atomic fixture projection + Moment revision + fixture event + outbox
-> foreground stream | push candidate | audio candidate | Room projection | Memory
```

Required durable records are:

- fixture schedule metadata with source timestamp and data freshness;
- normalized canonical events, source identity, ordering, and revision lineage;
- fixture projection and final decision metadata;
- fan profile, session, follows, notification subscriptions, and preferences;
- Room invite, membership, calls, reactions, and final result; and
- Memory metadata referencing the canonical event timeline.

Only after the transaction commits may an outbox worker fan out side effects.
The client may cache a presentation snapshot for offline display, but it cannot
create canonical history, a final result, or a Memory.

Source retention must comply with the hackathon data terms and any explicit
TxODDS permission. When raw retention is not allowed, retain only the minimum
authorized normalized facts required for the verified product timeline.

## 8. Release gates and feature-cut policy

The following are hard gates, not aspirational tests.

### Gate A — historical replay

Using the actual subscribed TxLINE credential, prove one completed fixture
returns a complete, ordered event sequence including finalization. Persist it,
rebuild the canonical projection from it, and prove replay produces the same
final score and Moments.

**Failure action:** remove Recorded Replay and the replay-based judge demo. Do
not replace them with authored sports data.

### Gate B — installed-device push

On the iPhone, Samsung tablet, and macOS web app: prove install, permission,
one real live event push, exact Moment activation from foreground/background,
and honest denied/disabled states.

**Failure action:** ship follow state and in-app Updates; hide the assertion
that lock-screen alerts work on the failed platform. Never fake delivery.

### Gate C — listening transport and speech

On the same devices: prove user gesture -> media stream attached -> one real
canonical event -> immediate cue -> factual speech or explicit fallback. Record
event-received, stream-attached, audio-enqueued, and media-start timestamps.

**Failure action:** retain in-app event cues and text; remove locked/background
Listening Mode and generated-speech marketing until it passes.

### Gate D — Room inputs

Prove a real completed fixture has the required result/goals/cards final facts,
that late callers cannot submit, and that correction/retry produces one final
leaderboard.

**Failure action:** do not render Create Room for fixtures that lack those
facts. A Room is not a local simulation fallback.

## 9. Scope that may ship

The release is only called end-to-end ready when every included module has
passed its relevant gate.

### Required core

- first launch, profile, favourite team, textile flags, accessible controls;
- truthful schedule categories and source freshness;
- live Companion, revision-safe Moment, and factual timeline;
- follows, standard push setup, and a labelled test alert;
- verified final result and Memory when data exists; and
- reliable mobile/desktop responsive states.

### Conditional modules

- Recorded Replay and judge replay walkthrough: Gate A;
- lock-screen push claim: Gate B;
- generated/locked Listening Mode: Gate C; and
- Rooms/Call Three: Gate D.

### Deliberately deferred

- player follow, player photo, player predictions, and multilingual spoken
  commentary;
- corners prediction until it passes Gate D's equivalent data test;
- sponsorship media, advertising, global rankings, friend discovery, and open
  chat; and
- native-only notification surfaces and all financial mechanics.

## 10. Acceptance evidence

Automated evidence must cover deterministic lifecycle reduction, duplicate and
revision behavior, server-owned schedule persistence, final/unavailable
classification, historical replay rebuild, source-to-outbox ordering, Room lock
and resolution, deep-link validation, and Listening Mode failure states.

Physical evidence must separately record iPhone, Samsung tablet, and macOS
results for install, permission, foreground update, background/locked push,
notification activation, audio start/pause/resume/interruption, reduced motion,
and narrow-screen layout. Browser automation cannot replace this device matrix.

## 11. Completion contract

The product is complete only when this real path is proven:

```text
install -> onboard -> choose favourite team -> follow a real fixture
-> receive/see a confirmed event -> open its exact Moment
-> observe correction-safe live state -> reach verified final -> open Memory
```

Recorded Replay, Rooms, lock-screen push, and Listening Mode are added only
after their named gates pass. That constraint protects MatchSense from looking
more complete than it actually is.
