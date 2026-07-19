import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  FanRepository,
  RoomAggregateRecord,
  RoomAggregateRepository,
  RoomStatus,
} from "@matchsense/db";
import type { FixtureSnapshot } from "@matchsense/contracts";
import {
  RoomsDomainError,
  addCallThreeReaction,
  createCallThreeRoom,
  finaliseCallThreeRoom,
  getCallThreeLeaderboard,
  joinCallThreeRoom,
  lockCallThreeCalls,
  overturnCallThreeMoment,
  projectCallThreeRoom,
  registerConfirmedCallThreeMoment,
  setCallThreeCalls,
  startCallThreeRoom,
  supersedeCallThreeMoment,
  type CallThreeInput,
  type CallThreeRoomState,
  type MomentRevision,
  type ReactionKind,
  type RoomReaction,
} from "@matchsense/rooms";

import { RoomServiceError } from "./room-service.js";

const MAX_CAS_ATTEMPTS = 4;
const ROOM_SUBSCRIPTION_POLL_INTERVAL_MS = 1_000;
const ROOM_FOLLOW_EVENT_PREFERENCES = {
  fullTime: true,
  goals: true,
  halfTime: true,
  penalties: true,
  redCards: true,
  var: true,
  yellowCards: true,
} as const;

/**
 * A room aggregate is intentionally versioned separately from the legacy Room
 * shape. Durable Call Three never reads the legacy allocation/slate fields.
 */
export interface DurableRoomAggregate {
  readonly fixture: FixtureSnapshot;
  readonly hostFanId: string;
  readonly lifecycle: readonly {
    readonly at: number;
    readonly status: "LOBBY" | "LIVE" | "FINAL";
  }[];
  readonly memberTeamCodes: Readonly<Record<string, string | null>>;
  readonly name: string;
  readonly reactionRecipients: Readonly<Record<string, string>>;
  readonly room: CallThreeRoomState;
  readonly schemaVersion: 2;
}

export interface DurableRoomReactionView {
  readonly id: string;
  readonly kind: ReactionKind;
  readonly momentId: string;
  readonly reactedAt: number;
  readonly recipientNickname: string;
  readonly recipientParticipantId: string;
  readonly recipientTeamCode: string | null;
  readonly revision: number;
  readonly senderNickname: string;
  readonly senderParticipantId: string;
  readonly senderTeamCode: string | null;
  readonly status: "VISIBLE" | "OVERTURNED";
}

export interface DurableRoomView {
  readonly id: string;
  readonly name: string;
  readonly fixture: FixtureSnapshot;
  readonly kickoffAt: number;
  readonly createdAt: number;
  readonly finalisedAt: number | null;
  readonly revision: number;
  readonly status: "PRE_KICKOFF" | "LIVE" | "FINAL";
  readonly viewerParticipantId: string;
  readonly friendPointsLabel: "MATCHSENSE POINTS · NO PRIZES";
  readonly points: {
    readonly label: "MATCHSENSE POINTS · NON-TRANSFERABLE";
    readonly lifetimeTotal: number;
    readonly roomPoints: number;
  };
  readonly hostParticipantId: string;
  readonly members: readonly {
    readonly id: string;
    readonly nickname: string;
    readonly role: "PLAYER" | "SPECTATOR";
    readonly joinedAt: number;
    readonly hasCalls: boolean;
    readonly isHost: boolean;
    readonly lockedAt: number | null;
    readonly teamCode: string | null;
  }[];
  readonly myCalls: CallThreeRoomState["callSlates"][string] | null;
  readonly leaderboard: ReturnType<typeof getCallThreeLeaderboard>;
  readonly targets: CallThreeRoomState["targets"];
  readonly currentMoment: MomentRevision | null;
  readonly moments: readonly MomentRevision[];
  readonly reactions: readonly DurableRoomReactionView[];
}

export interface DurableRoomPreview {
  readonly callsLocked: boolean;
  readonly expiresAt: number;
  readonly fixture: FixtureSnapshot;
  readonly hostNickname: string;
  readonly kickoffAt: number;
  readonly memberCount: number;
  readonly memberNicknames: readonly string[];
  readonly name: string;
  readonly roomId: string;
  readonly status: DurableRoomView["status"];
}

export interface DurableRoomStreamEvent {
  readonly event: "room.snapshot" | "room.updated";
  readonly id: string;
  readonly revision: number;
  readonly room: DurableRoomView;
}

export interface DurableRoomServiceOptions {
  fixture(
    fixtureId: string,
  ): FixtureSnapshot | null | Promise<FixtureSnapshot | null>;
  followFixture?: Pick<FanRepository, "upsertFollow">["upsertFollow"];
  inviteBytes?: (() => Buffer) | undefined;
  now?: (() => number) | undefined;
  repository: RoomAggregateRepository<DurableRoomAggregate>;
  roomId?: (() => string) | undefined;
  /**
   * Kept only so existing process wiring remains type-compatible while public
   * synthetic Experience controls are removed. It is deliberately unused.
   */
  startFixture?:
    | ((input: {
        fixture: FixtureSnapshot;
        ownerFanId: string;
      }) => Promise<FixtureSnapshot>)
    | undefined;
}

function hashInvite(inviteCode: string) {
  return createHash("sha256").update(inviteCode, "utf8").digest("hex");
}

function normalizedRoomName(value: string) {
  const name = value.trim();
  if (name.length < 1 || name.length > 60) {
    throw new RoomServiceError(
      "INVALID_ROOM_NAME",
      400,
      "Room name must be between 1 and 60 characters",
    );
  }
  return name;
}

function finiteTimestamp(value: string, fallback: number) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function durableStatus(status: RoomStatus): DurableRoomView["status"] {
  if (status === "final") return "FINAL";
  if (status === "live") return "LIVE";
  return "PRE_KICKOFF";
}

function isCallThreeAggregate(value: unknown): value is DurableRoomAggregate {
  if (!value || typeof value !== "object") return false;
  const aggregate = value as Partial<DurableRoomAggregate>;
  return (
    aggregate.schemaVersion === 2 &&
    !!aggregate.room &&
    typeof aggregate.room === "object" &&
    !!aggregate.fixture &&
    typeof aggregate.fixture === "object"
  );
}

function requireCallThreeAggregate(
  record: RoomAggregateRecord<DurableRoomAggregate>,
) {
  if (!isCallThreeAggregate(record.aggregate)) {
    throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
  }
  return record.aggregate;
}

function finalisedAt(record: RoomAggregateRecord<DurableRoomAggregate>) {
  const aggregate = requireCallThreeAggregate(record);
  return aggregate.room.finalisedAt === null
    ? null
    : new Date(aggregate.room.finalisedAt).toISOString();
}

function roomPointsForFan(
  record: RoomAggregateRecord<DurableRoomAggregate>,
  fanId: string,
) {
  if (record.status !== "final" || !isCallThreeAggregate(record.aggregate)) {
    return 0;
  }
  return (
    getCallThreeLeaderboard(record.aggregate.room).find(
      (entry) => entry.participantId === fanId,
    )?.score ?? 0
  );
}

function reactionView(
  aggregate: DurableRoomAggregate,
  reaction: RoomReaction,
): DurableRoomReactionView | null {
  const recipientParticipantId =
    aggregate.reactionRecipients[reaction.id] ?? null;
  const sender = aggregate.room.members.find(
    ({ id }) => id === reaction.participantId,
  );
  const recipient = aggregate.room.members.find(
    ({ id }) => id === recipientParticipantId,
  );
  if (!sender || !recipient || !recipientParticipantId) return null;
  return {
    id: reaction.id,
    kind: reaction.kind,
    momentId: reaction.momentId,
    reactedAt: reaction.reactedAt,
    recipientNickname: recipient.nickname,
    recipientParticipantId,
    recipientTeamCode:
      aggregate.memberTeamCodes[recipientParticipantId] ?? null,
    revision: reaction.revision,
    senderNickname: sender.nickname,
    senderParticipantId: reaction.participantId,
    senderTeamCode: aggregate.memberTeamCodes[reaction.participantId] ?? null,
    status: reaction.status === "OVERTURNED" ? "OVERTURNED" : "VISIBLE",
  };
}

function buildView(
  record: RoomAggregateRecord<DurableRoomAggregate>,
  fanId: string,
  lifetimeTotal: number,
): DurableRoomView {
  const aggregate = requireCallThreeAggregate(record);
  const member = aggregate.room.members.find(({ id }) => id === fanId);
  if (!member) {
    throw new RoomServiceError(
      "ROOM_SESSION_REQUIRED",
      403,
      "This fan is not a Room member",
    );
  }
  const moments = Object.values(aggregate.room.moments).sort(
    (left, right) => left.revision - right.revision,
  );
  const reactions = aggregate.room.reactions.flatMap((reaction) => {
    const view = reactionView(aggregate, reaction);
    return view ? [view] : [];
  });
  const roomPoints = roomPointsForFan(record, fanId);
  return {
    createdAt: aggregate.room.createdAt,
    currentMoment: moments.at(-1) ?? null,
    finalisedAt: aggregate.room.finalisedAt,
    fixture: aggregate.fixture,
    friendPointsLabel: "MATCHSENSE POINTS · NO PRIZES",
    hostParticipantId: aggregate.hostFanId,
    id: record.id,
    kickoffAt: aggregate.room.kickoffAt,
    leaderboard: getCallThreeLeaderboard(aggregate.room),
    members: aggregate.room.members.map((roomMember) => ({
      hasCalls: aggregate.room.callSlates[roomMember.id] !== undefined,
      id: roomMember.id,
      isHost: roomMember.id === aggregate.hostFanId,
      joinedAt: roomMember.joinedAt,
      lockedAt: aggregate.room.callSlates[roomMember.id]?.lockedAt ?? null,
      nickname: roomMember.nickname,
      role: roomMember.role,
      teamCode: aggregate.memberTeamCodes[roomMember.id] ?? null,
    })),
    moments,
    myCalls: aggregate.room.callSlates[fanId] ?? null,
    name: aggregate.name,
    points: {
      label: "MATCHSENSE POINTS · NON-TRANSFERABLE",
      lifetimeTotal,
      roomPoints,
    },
    reactions,
    revision: record.version + 1,
    status: durableStatus(record.status),
    targets: aggregate.room.targets,
    viewerParticipantId: fanId,
  };
}

function regulationResult(
  fixture: FixtureSnapshot,
): "HOME" | "DRAW" | "AWAY" | null {
  const score = fixture.scores?.regulation;
  if (!score) return null;
  if (score.home > score.away) return "HOME";
  if (score.away > score.home) return "AWAY";
  return "DRAW";
}

function cardTotal(fixture: FixtureSnapshot) {
  if (!fixture.stats) return null;
  return (
    fixture.stats.home.yellowCards +
    fixture.stats.home.redCards +
    fixture.stats.away.yellowCards +
    fixture.stats.away.redCards
  );
}

function isVerifiedFinal(fixture: FixtureSnapshot) {
  const moment = fixture.lastEvent;
  return (
    fixture.provenance === "live_txline" &&
    fixture.phase === "full_time" &&
    moment?.kind === "phase.full_time" &&
    moment.status === "confirmed"
  );
}

function isVerifiedFinalRevision(
  fixture: FixtureSnapshot,
  room: CallThreeRoomState,
) {
  // The first final must cross the strict confirmed full-time gate. Once that
  // durable boundary exists, later canonical full-time revisions may correct
  // the same verified result without freezing the Room at an older score.
  if (isVerifiedFinal(fixture)) return true;
  const moment = fixture.lastEvent;
  return (
    room.status === "FINAL" &&
    room.finalisedVersion !== null &&
    fixture.provenance === "live_txline" &&
    fixture.phase === "full_time" &&
    moment?.provenance === "live_txline" &&
    moment.revision === fixture.revision &&
    (moment.status === "confirmed" ||
      moment.status === "corrected" ||
      moment.status === "overturned")
  );
}

function projectCanonicalMoment(
  room: CallThreeRoomState,
  moment: NonNullable<FixtureSnapshot["lastEvent"]>,
) {
  if (moment.status === "overturned") {
    return overturnCallThreeMoment(room, {
      momentId: moment.id,
      revision: moment.revision,
    });
  }
  if (moment.status === "corrected") {
    return registerConfirmedCallThreeMoment(
      supersedeCallThreeMoment(room, {
        momentId: moment.id,
        revision: moment.revision,
      }),
      { momentId: moment.id, revision: moment.revision },
    );
  }
  if (moment.status === "confirmed") {
    return registerConfirmedCallThreeMoment(room, {
      momentId: moment.id,
      revision: moment.revision,
    });
  }
  // Provisional and under-review records remain in raw/canonical history, but
  // never become a Room reaction target.
  return room;
}

function appendLifecycle(
  lifecycle: DurableRoomAggregate["lifecycle"],
  entry: DurableRoomAggregate["lifecycle"][number],
) {
  return lifecycle.at(-1)?.status === entry.status
    ? lifecycle
    : [...lifecycle, entry];
}

function verifiedFinalFacts(fixture: FixtureSnapshot, finalisedAt: number) {
  return {
    finalisedAt,
    regulationResult: regulationResult(fixture),
    totalCards: cardTotal(fixture),
    totalGoals: fixture.score.home + fixture.score.away,
    verified: true,
    version: fixture.revision,
  } as const;
}

function assertEligibleFixture(fixture: FixtureSnapshot, observedAt: number) {
  const kickoffAt = Date.parse(fixture.kickoffAt);
  if (
    fixture.provenance !== "live_txline" ||
    fixture.phase !== "scheduled" ||
    !Number.isFinite(kickoffAt) ||
    observedAt >= kickoffAt
  ) {
    throw new RoomsDomainError(
      "ROOM_NOT_ELIGIBLE",
      "Call Three is available only before kickoff for scheduled live TxLINE fixtures",
    );
  }
  return kickoffAt;
}

export function createDurableRoomService(options: DurableRoomServiceOptions) {
  const now = options.now ?? Date.now;
  const makeRoomId = options.roomId ?? randomUUID;
  const makeInviteBytes = options.inviteBytes ?? (() => randomBytes(16));
  type RoomSubscriptionState = {
    delivery: Promise<void>;
    fanSubscribers: Map<string, Set<(event: DurableRoomStreamEvent) => void>>;
    lastVersion: number;
    pollInFlight: boolean;
    pollTimer: ReturnType<typeof setInterval> | null;
  };
  const subscribers = new Map<string, RoomSubscriptionState>();

  const lifetimePointsForFan = async (fanId: string) => {
    const records = await options.repository.listForFan(fanId);
    return records.reduce(
      (total, record) => total + roomPointsForFan(record, fanId),
      0,
    );
  };

  const viewFor = async (
    record: RoomAggregateRecord<DurableRoomAggregate>,
    fanId: string,
  ) => buildView(record, fanId, await lifetimePointsForFan(fanId));

  const publish = async (record: RoomAggregateRecord<DurableRoomAggregate>) => {
    const state = subscribers.get(record.id);
    if (!state) return;
    const delivery = state.delivery
      .catch(() => undefined)
      .then(async () => {
        if (
          subscribers.get(record.id) !== state ||
          record.version <= state.lastVersion
        ) {
          return;
        }
        for (const [fanId, listeners] of state.fanSubscribers) {
          const event: DurableRoomStreamEvent = {
            event: "room.updated",
            id: `${record.id}:${record.version + 1}`,
            revision: record.version + 1,
            room: await viewFor(record, fanId),
          };
          for (const listener of listeners) listener(event);
        }
        state.lastVersion = record.version;
      });
    state.delivery = delivery;
    await delivery;
  };

  const pollSubscribedRoom = async (
    roomId: string,
    state: RoomSubscriptionState,
  ) => {
    if (subscribers.get(roomId) !== state || state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      const record = await options.repository.get(roomId);
      if (
        record &&
        isCallThreeAggregate(record.aggregate) &&
        record.version > state.lastVersion
      ) {
        await publish(record);
      }
    } catch {
      // Keep the SSE connection alive; the next bounded poll retries the read.
    } finally {
      state.pollInFlight = false;
    }
  };

  const startSubscriptionPolling = (
    roomId: string,
    state: RoomSubscriptionState,
  ) => {
    const timer = setInterval(() => {
      void pollSubscribedRoom(roomId, state);
    }, ROOM_SUBSCRIPTION_POLL_INTERVAL_MS);
    timer.unref?.();
    state.pollTimer = timer;
  };

  const recordFor = async (roomId: string) => {
    const record = await options.repository.get(roomId);
    if (!record || !isCallThreeAggregate(record.aggregate)) {
      throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
    }
    return record;
  };

  type Mutation = {
    readonly aggregate: DurableRoomAggregate;
    readonly finalizedAt?: string | null;
    readonly status: RoomStatus;
  };

  const update = async (
    roomId: string,
    mutate: (
      record: RoomAggregateRecord<DurableRoomAggregate>,
    ) => Mutation | null,
  ) => {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await recordFor(roomId);
      const next = mutate(current);
      if (!next) return current;
      const updated = await options.repository.compareAndSwap({
        aggregate: next.aggregate,
        expectedVersion: current.version,
        finalizedAt: next.finalizedAt ?? finalisedAt(current),
        roomId,
        status: next.status,
      });
      if (updated) {
        await publish(updated);
        return updated;
      }
    }
    throw new RoomsDomainError(
      "REVISION_CONFLICT",
      "The Room changed; refresh and try again",
    );
  };

  const service = {
    async create(input: {
      fixtureId: string;
      host: { fanId: string; nickname: string; teamCode?: string | undefined };
      name: string;
    }) {
      const fixture = await options.fixture(input.fixtureId);
      if (!fixture) {
        throw new RoomServiceError(
          "FIXTURE_NOT_FOUND",
          404,
          "Fixture not found",
        );
      }
      const createdAt = now();
      const kickoffAt = assertEligibleFixture(fixture, createdAt);
      const id = makeRoomId();
      const inviteCode = makeInviteBytes().toString("base64url");
      const room = createCallThreeRoom({
        createdAt,
        fixture: {
          fixtureId: fixture.fixtureId,
          kickoffAt,
          provenance: fixture.provenance,
        },
        host: { id: input.host.fanId, nickname: input.host.nickname },
        id,
      });
      const aggregate: DurableRoomAggregate = {
        fixture,
        hostFanId: input.host.fanId,
        lifecycle: [{ at: createdAt, status: "LOBBY" }],
        memberTeamCodes: { [input.host.fanId]: input.host.teamCode ?? null },
        name: normalizedRoomName(input.name),
        reactionRecipients: {},
        room,
        schemaVersion: 2,
      };
      await options.followFixture?.({
        eventPreferences: ROOM_FOLLOW_EVENT_PREFERENCES,
        fanId: input.host.fanId,
        fixtureId: fixture.fixtureId,
        mode: "live",
      });
      const record = await options.repository.create({
        aggregate,
        fixtureId: fixture.fixtureId,
        host: {
          fanId: input.host.fanId,
          nickname: input.host.nickname,
          teamCode: input.host.teamCode ?? null,
        },
        id,
        inviteExpiresAt: new Date(kickoffAt + 8 * 60 * 60_000).toISOString(),
        inviteHash: hashInvite(inviteCode),
        mode: "live",
        status: "lobby",
      });
      return {
        inviteCode,
        invitePath: `/rooms/join/${inviteCode}`,
        room: await viewFor(record, input.host.fanId),
      };
    },

    async preview(inviteCode: string): Promise<DurableRoomPreview> {
      const record = await options.repository.previewByInviteHash(
        hashInvite(inviteCode),
      );
      if (
        !record ||
        !isCallThreeAggregate(record.aggregate) ||
        Date.parse(record.inviteExpiresAt) <= now()
      ) {
        throw new RoomServiceError(
          "INVITE_NOT_FOUND",
          404,
          "Room invite not found",
        );
      }
      const host = record.aggregate.room.members.find(
        ({ id }) => id === record.aggregate.hostFanId,
      );
      if (!host) {
        throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
      }
      return {
        callsLocked: record.aggregate.room.status !== "PRE_KICKOFF",
        expiresAt: Date.parse(record.inviteExpiresAt),
        fixture: record.aggregate.fixture,
        hostNickname: host.nickname,
        kickoffAt: record.aggregate.room.kickoffAt,
        memberCount: record.aggregate.room.members.length,
        memberNicknames: record.aggregate.room.members.map(
          ({ nickname }) => nickname,
        ),
        name: record.aggregate.name,
        roomId: record.id,
        status: durableStatus(record.status),
      };
    },

    async join(input: {
      fanId: string;
      inviteCode: string;
      nickname: string;
      teamCode?: string | undefined;
    }) {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await options.repository.previewByInviteHash(
          hashInvite(input.inviteCode),
        );
        if (
          !current ||
          !isCallThreeAggregate(current.aggregate) ||
          Date.parse(current.inviteExpiresAt) <= now()
        ) {
          throw new RoomServiceError(
            "INVITE_NOT_FOUND",
            404,
            "Room invite not found",
          );
        }
        if (current.aggregate.room.members.length >= 20) {
          throw new RoomServiceError(
            "ROOM_FULL",
            409,
            "This room already has its maximum of 20 fans",
          );
        }
        const joinedAt = now();
        const room = joinCallThreeRoom(current.aggregate.room, {
          joinedAt,
          participant: { id: input.fanId, nickname: input.nickname },
        });
        const joined = room.members.find(({ id }) => id === input.fanId);
        if (!joined) {
          throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
        }
        const nextStatus: RoomStatus =
          room.status === "FINAL"
            ? "final"
            : room.status === "LIVE"
              ? "live"
              : "lobby";
        const aggregate: DurableRoomAggregate = {
          ...current.aggregate,
          lifecycle:
            nextStatus === "live"
              ? appendLifecycle(current.aggregate.lifecycle, {
                  at: Math.max(joinedAt, room.kickoffAt),
                  status: "LIVE",
                })
              : current.aggregate.lifecycle,
          memberTeamCodes: {
            ...current.aggregate.memberTeamCodes,
            [input.fanId]: input.teamCode ?? null,
          },
          room,
        };
        await options.followFixture?.({
          eventPreferences: ROOM_FOLLOW_EVENT_PREFERENCES,
          fanId: input.fanId,
          fixtureId: current.fixtureId,
          mode: "live",
        });
        const updated = await options.repository.joinAndCompareAndSwap({
          aggregate,
          expectedVersion: current.version,
          finalizedAt: finalisedAt(current),
          member: {
            fanId: input.fanId,
            nickname: input.nickname,
            role: joined.role === "PLAYER" ? "member" : "spectator",
            teamCode: input.teamCode ?? null,
          },
          roomId: current.id,
          status: nextStatus,
        });
        if (updated) {
          await publish(updated);
          return viewFor(updated, input.fanId);
        }
      }
      throw new RoomsDomainError(
        "REVISION_CONFLICT",
        "The Room changed; refresh and try again",
      );
    },

    async get(roomId: string, fanId: string) {
      return viewFor(await recordFor(roomId), fanId);
    },

    async list(fanId: string) {
      const records = await options.repository.listForFan(fanId);
      const lifetimeTotal = await lifetimePointsForFan(fanId);
      return records.flatMap((record) =>
        isCallThreeAggregate(record.aggregate)
          ? [buildView(record, fanId, lifetimeTotal)]
          : [],
      );
    },

    async subscribe(
      roomId: string,
      fanId: string,
      listener: (event: DurableRoomStreamEvent) => void,
    ) {
      const record = await recordFor(roomId);
      let state = subscribers.get(roomId);
      if (!state) {
        state = {
          delivery: Promise.resolve(),
          fanSubscribers: new Map(),
          lastVersion: record.version,
          pollInFlight: false,
          pollTimer: null,
        };
        subscribers.set(roomId, state);
      } else {
        await publish(record);
      }
      let fanSubscribers = state.fanSubscribers.get(fanId);
      if (!fanSubscribers) {
        fanSubscribers = new Set();
        state.fanSubscribers.set(fanId, fanSubscribers);
      }
      fanSubscribers.add(listener);
      listener({
        event: "room.snapshot",
        id: `${record.id}:${record.version + 1}`,
        revision: record.version + 1,
        room: await viewFor(record, fanId),
      });
      if (!state.pollTimer) startSubscriptionPolling(roomId, state);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        fanSubscribers?.delete(listener);
        if (fanSubscribers?.size === 0) state?.fanSubscribers.delete(fanId);
        if (state?.fanSubscribers.size === 0) {
          if (state.pollTimer) clearInterval(state.pollTimer);
          state.pollTimer = null;
          if (subscribers.get(roomId) === state) subscribers.delete(roomId);
        }
      };
    },

    async setCalls(input: {
      calls: readonly CallThreeInput[];
      fanId: string;
      roomId: string;
    }) {
      const updated = await update(input.roomId, (current) => {
        const aggregate = requireCallThreeAggregate(current);
        return {
          aggregate: {
            ...aggregate,
            room: setCallThreeCalls(aggregate.room, {
              calls: input.calls,
              changedAt: now(),
              participantId: input.fanId,
            }),
          },
          status: current.status,
        };
      });
      return viewFor(updated, input.fanId);
    },

    async lockCalls(input: { fanId: string; roomId: string }) {
      const updated = await update(input.roomId, (current) => {
        const aggregate = requireCallThreeAggregate(current);
        return {
          aggregate: {
            ...aggregate,
            room: lockCallThreeCalls(aggregate.room, {
              lockedAt: now(),
              participantId: input.fanId,
            }),
          },
          status: current.status,
        };
      });
      return viewFor(updated, input.fanId);
    },

    async react(input: {
      fanId: string;
      kind: ReactionKind;
      momentId: string;
      recipientParticipantId: string;
      revision: number;
      roomId: string;
    }) {
      const updated = await update(input.roomId, (current) => {
        const aggregate = requireCallThreeAggregate(current);
        const recipient = aggregate.room.members.find(
          ({ id }) => id === input.recipientParticipantId,
        );
        if (!recipient || input.recipientParticipantId === input.fanId) {
          throw new RoomServiceError(
            "REACTION_RECIPIENT_INVALID",
            400,
            "Reaction recipient must be another room member",
          );
        }
        const result = addCallThreeReaction(aggregate.room, {
          kind: input.kind,
          momentId: input.momentId,
          participantId: input.fanId,
          reactedAt: Math.max(now(), aggregate.room.kickoffAt),
          revision: input.revision,
        });
        if (!result.accepted || !result.reaction) {
          const errors = {
            DUPLICATE: [
              "REACTION_DUPLICATE",
              "You already reacted to this Moment",
            ],
            MOMENT_OVERTURNED: [
              "REACTION_MOMENT_OVERTURNED",
              "This Moment was overturned",
            ],
            RATE_LIMITED: [
              "REACTION_RATE_LIMITED",
              "Reactions are temporarily limited",
            ],
          } as const;
          const [code, message] = errors[result.reason ?? "DUPLICATE"];
          throw new RoomServiceError(code, 409, message);
        }
        return {
          aggregate: {
            ...aggregate,
            reactionRecipients: {
              ...aggregate.reactionRecipients,
              [result.reaction.id]: input.recipientParticipantId,
            },
            room: result.room,
          },
          status: current.status,
        };
      });
      const room = await viewFor(updated, input.fanId);
      const reaction = room.reactions.find(
        ({ momentId, revision, senderParticipantId }) =>
          momentId === input.momentId &&
          revision === input.revision &&
          senderParticipantId === input.fanId,
      );
      if (!reaction) {
        throw new RoomServiceError(
          "REACTION_RECIPIENT_INVALID",
          400,
          "Reaction recipient is invalid",
        );
      }
      return { reaction, room };
    },
  };

  return {
    ...service,
    async projectFixture(fixture: FixtureSnapshot) {
      if (fixture.provenance !== "live_txline") return 0;
      const records = await options.repository.listByFixture({
        fixtureId: fixture.fixtureId,
        mode: "live",
      });
      let projected = 0;
      for (const candidate of records) {
        if (!isCallThreeAggregate(candidate.aggregate)) continue;
        const before = candidate.version;
        const updated = await update(candidate.id, (current) => {
          const aggregate = requireCallThreeAggregate(current);
          if (fixture.revision <= aggregate.fixture.revision) return null;
          const verifiedFinalRevision = isVerifiedFinalRevision(
            fixture,
            aggregate.room,
          );
          if (aggregate.room.status === "FINAL" && !verifiedFinalRevision) {
            return null;
          }
          const observedAt = Math.max(
            now(),
            finiteTimestamp(fixture.updatedAt, aggregate.room.kickoffAt),
            aggregate.room.kickoffAt,
          );
          let room = aggregate.room;
          if (room.status !== "FINAL" && fixture.phase !== "scheduled") {
            room = startCallThreeRoom(room, { observedAt });
          }
          if (
            room.status !== "FINAL" &&
            fixture.phase !== "scheduled" &&
            fixture.lastEvent
          ) {
            room = projectCanonicalMoment(room, fixture.lastEvent);
          }
          if (
            room.status !== "FINAL" &&
            fixture.phase !== "scheduled" &&
            fixture.revision > 0
          ) {
            const result = regulationResult(fixture);
            if (result) {
              room = projectCallThreeRoom(room, {
                observedAt,
                regulationResult: result,
                totalCards: cardTotal(fixture),
                totalGoals: fixture.score.home + fixture.score.away,
                version: fixture.revision,
              });
            }
          }

          let status: RoomStatus =
            room.status === "FINAL"
              ? "final"
              : room.status === "LIVE"
                ? "live"
                : "lobby";
          let finalizedAt: string | null | undefined;
          if (verifiedFinalRevision) {
            room = finaliseCallThreeRoom(room, {
              facts: verifiedFinalFacts(fixture, observedAt),
            });
            status = "final";
            finalizedAt = new Date(
              room.finalisedAt ?? observedAt,
            ).toISOString();
          }
          const lifecycleStatus =
            status === "final" ? "FINAL" : status === "live" ? "LIVE" : "LOBBY";
          return {
            aggregate: {
              ...aggregate,
              fixture,
              lifecycle: appendLifecycle(aggregate.lifecycle, {
                at: observedAt,
                status: lifecycleStatus,
              }),
              room,
            },
            ...(finalizedAt === undefined ? {} : { finalizedAt }),
            status,
          };
        });
        if (updated.version > before) projected += 1;
      }
      return projected;
    },
  };
}

export type DurableRoomService = ReturnType<typeof createDurableRoomService>;
