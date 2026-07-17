import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  PersistenceMode,
  RoomAggregateRecord,
  RoomAggregateRepository,
  RoomStatus,
} from "@matchsense/db";
import type { FixtureSnapshot } from "@matchsense/contracts";
import {
  CALL_CATEGORIES,
  SENSE_MARKETS,
  addReaction,
  createRoom,
  finaliseRoom,
  getLeaderboard,
  joinRoom,
  registerMoment,
  resolveMoment,
  scoreSenseSlates,
  validateSensePicks,
  type ReactionKind,
  type RoomState,
  type SenseOutcomes,
  type SensePickInput,
  type SenseRoomPhase,
  type SenseSlate,
} from "@matchsense/rooms";

import {
  RoomServiceError,
  type RoomPreview,
  type RoomReactionView,
  type RoomStreamEvent,
  type RoomView,
} from "./room-service.js";

const STARTING_SENSE = 100 as const;
const MAX_CAS_ATTEMPTS = 4;

export interface DurableSenseLedgerEntry {
  available: number;
  committed: number;
  returned: number | null;
  starting: typeof STARTING_SENSE;
}

export interface DurableRoomAggregate {
  fixture: FixtureSnapshot;
  hostFanId: string;
  ledger: Record<string, DurableSenseLedgerEntry>;
  lifecycle: readonly {
    at: number;
    status: "LOBBY" | "LOCKED" | "LIVE" | "FINAL";
  }[];
  memberTeamCodes: Record<string, string | null>;
  name: string;
  reactionRecipients: Record<string, string>;
  room: RoomState;
  schemaVersion: 1;
  senseOutcomes: SenseOutcomes | null;
  sensePhase: SenseRoomPhase;
  senseSlates: Record<string, SenseSlate>;
  startedAt: number | null;
  statTotals: Record<(typeof CALL_CATEGORIES)[number], number | null>;
}

export interface DurableRoomView extends Omit<RoomView, "sense"> {
  readonly sense: RoomView["sense"] & {
    readonly balance: DurableSenseLedgerEntry;
    readonly ledger: Readonly<Record<string, DurableSenseLedgerEntry>>;
  };
}

export interface DurableRoomServiceOptions {
  fixture(
    fixtureId: string,
  ): FixtureSnapshot | null | Promise<FixtureSnapshot | null>;
  inviteBytes?: (() => Buffer) | undefined;
  now?: (() => number) | undefined;
  repository: RoomAggregateRepository<DurableRoomAggregate>;
  roomId?: (() => string) | undefined;
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

function modeFor(fixture: FixtureSnapshot): PersistenceMode {
  return fixture.provenance === "live_txline" ? "live" : "demo";
}

function roomStatus(status: RoomStatus): RoomView["status"] {
  if (status === "final") return "FINAL";
  if (status === "live") return "LIVE";
  return "PRE_KICKOFF";
}

function senseBalance(): DurableSenseLedgerEntry {
  return {
    available: STARTING_SENSE,
    committed: 0,
    returned: null,
    starting: STARTING_SENSE,
  };
}

function outcomesForFixture(fixture: FixtureSnapshot): SenseOutcomes {
  const cards = fixture.stats
    ? fixture.stats.home.yellowCards +
      fixture.stats.home.redCards +
      fixture.stats.away.yellowCards +
      fixture.stats.away.redCards
    : null;
  const corners = fixture.stats
    ? fixture.stats.home.corners + fixture.stats.away.corners
    : null;
  const goals = fixture.score.home + fixture.score.away;
  return {
    btts: fixture.score.home > 0 && fixture.score.away > 0 ? "YES" : "NO",
    cards_4_5: cards === null ? "VOID" : cards > 4.5 ? "OVER" : "UNDER",
    corners_9_5: corners === null ? "VOID" : corners > 9.5 ? "OVER" : "UNDER",
    goals_2_5: goals > 2.5 ? "OVER" : "UNDER",
    winner:
      fixture.score.home > fixture.score.away
        ? "HOME"
        : fixture.score.away > fixture.score.home
          ? "AWAY"
          : "DRAW",
  };
}

function projectCanonicalMoment(
  room: RoomState,
  moment: NonNullable<FixtureSnapshot["lastEvent"]>,
) {
  const existing = Object.values(room.moments).find(
    (candidate) =>
      candidate.momentId === moment.id &&
      candidate.revision === moment.revision,
  );
  const isReview =
    moment.status === "provisional" || moment.status === "under_review";
  if (isReview) {
    return existing
      ? room
      : registerMoment(room, {
          momentId: moment.id,
          revision: moment.revision,
          varState: "HOLD",
        });
  }

  const resolution =
    moment.status === "overturned"
      ? ("OVERTURNED" as const)
      : moment.status === "confirmed" || moment.status === "corrected"
        ? ("CONFIRMED" as const)
        : null;
  let projected = room;
  if (resolution) {
    for (const prior of Object.values(projected.moments)) {
      if (
        prior.momentId === moment.id &&
        prior.revision <= moment.revision &&
        prior.varState === "HOLD"
      ) {
        projected = resolveMoment(projected, {
          momentId: prior.momentId,
          resolution,
          revision: prior.revision,
        });
      }
    }
  }

  const current = Object.values(projected.moments).find(
    (candidate) =>
      candidate.momentId === moment.id &&
      candidate.revision === moment.revision,
  );
  if (!current) {
    projected = registerMoment(projected, {
      momentId: moment.id,
      revision: moment.revision,
      varState: moment.status === "overturned" ? "HOLD" : "CLEAR",
    });
  }
  if (moment.status === "overturned") {
    const registered = Object.values(projected.moments).find(
      (candidate) =>
        candidate.momentId === moment.id &&
        candidate.revision === moment.revision,
    );
    return registered?.varState === "OVERTURNED"
      ? projected
      : resolveMoment(projected, {
          momentId: moment.id,
          resolution: "OVERTURNED",
          revision: moment.revision,
        });
  }
  return projected;
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

function finalizedAt(record: RoomAggregateRecord<DurableRoomAggregate>) {
  return record.aggregate.room.finalisedAt === null
    ? null
    : new Date(record.aggregate.room.finalisedAt).toISOString();
}

function buildView(
  record: RoomAggregateRecord<DurableRoomAggregate>,
  fanId: string,
): DurableRoomView {
  const aggregate = record.aggregate;
  const member = aggregate.room.members.find(({ id }) => id === fanId);
  if (!member) {
    throw new RoomServiceError(
      "ROOM_SESSION_REQUIRED",
      403,
      "This fan is not a Room member",
    );
  }
  const phase =
    record.status === "final"
      ? "FINAL"
      : record.status === "live"
        ? "LIVE"
        : record.status === "locked"
          ? "LOCKED"
          : aggregate.sensePhase;
  const moments = Object.values(aggregate.room.moments);
  const reactions = aggregate.room.reactions.flatMap((reaction) => {
    const recipientParticipantId =
      aggregate.reactionRecipients[reaction.id] ?? null;
    const sender = aggregate.room.members.find(
      ({ id }) => id === reaction.participantId,
    );
    const recipient = aggregate.room.members.find(
      ({ id }) => id === recipientParticipantId,
    );
    if (!sender || !recipient || !recipientParticipantId) return [];
    return [
      {
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
        senderTeamCode:
          aggregate.memberTeamCodes[reaction.participantId] ?? null,
        status: reaction.status,
      } satisfies RoomReactionView,
    ];
  });
  const senseLeaderboard = aggregate.senseOutcomes
    ? scoreSenseSlates({
        members: aggregate.room.members,
        outcomes: aggregate.senseOutcomes,
        slates: aggregate.senseSlates,
      })
    : [];
  const legacyLeaderboard = getLeaderboard(aggregate.room).map((entry) => {
    const slate = aggregate.room.callSlates[entry.participantId];
    const correctCalls = slate
      ? CALL_CATEGORIES.filter((category) => {
          const stat = aggregate.room.stats[category];
          return (
            stat?.state === "RELIABLE" &&
            stat.answer === slate.calls[category].answer
          );
        }).length
      : 0;
    return { ...entry, correctCalls };
  });
  const balance = aggregate.ledger[fanId] ?? {
    available: 0,
    committed: 0,
    returned: null,
    starting: STARTING_SENSE,
  };

  return {
    createdAt: aggregate.room.createdAt,
    currentMoment: moments.at(-1) ?? null,
    finalisedAt: aggregate.room.finalisedAt,
    fixture: aggregate.fixture,
    friendPointsLabel: "FRIEND POINTS · NO PRIZES",
    hostParticipantId: aggregate.hostFanId,
    id: record.id,
    kickoffAt: aggregate.room.kickoffAt,
    leaderboard: legacyLeaderboard,
    members: aggregate.room.members.map((roomMember) => ({
      hasCalls: aggregate.room.callSlates[roomMember.id] !== undefined,
      hasPicks: aggregate.senseSlates[roomMember.id] !== undefined,
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
    reactions,
    revision: record.version + 1,
    sense: {
      balance,
      currencyLabel: "FRIEND SENSE · NO MONEY · NO PRIZES",
      leaderboard: senseLeaderboard,
      ledger: aggregate.ledger,
      markets: SENSE_MARKETS,
      mySlate: aggregate.senseSlates[fanId] ?? null,
      phase,
      revealedSlates:
        phase === "LOCKED" || phase === "LIVE" || phase === "FINAL"
          ? Object.values(aggregate.senseSlates)
          : [],
      total: STARTING_SENSE,
    },
    stats: Object.fromEntries(
      CALL_CATEGORIES.map((category) => {
        const stat = aggregate.room.stats[category];
        return [
          category,
          stat ? { ...stat, total: aggregate.statTotals[category] } : null,
        ];
      }),
    ) as RoomView["stats"],
    status: roomStatus(record.status),
    viewerParticipantId: fanId,
  };
}

export function createDurableRoomService(options: DurableRoomServiceOptions) {
  const now = options.now ?? Date.now;
  const makeRoomId = options.roomId ?? randomUUID;
  const makeInviteBytes = options.inviteBytes ?? (() => randomBytes(16));
  const subscribers = new Map<
    string,
    Map<string, Set<(event: RoomStreamEvent) => void>>
  >();

  const publish = (record: RoomAggregateRecord<DurableRoomAggregate>) => {
    const roomSubscribers = subscribers.get(record.id);
    if (!roomSubscribers) return;
    for (const [fanId, listeners] of roomSubscribers) {
      const event: RoomStreamEvent = {
        event: "room.updated",
        id: `${record.id}:${record.version + 1}`,
        revision: record.version + 1,
        room: buildView(record, fanId),
      };
      for (const listener of listeners) listener(event);
    }
  };

  const recordFor = async (roomId: string) => {
    const record = await options.repository.get(roomId);
    if (!record) {
      throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
    }
    return record;
  };

  const update = async (
    roomId: string,
    mutate: (record: RoomAggregateRecord<DurableRoomAggregate>) => {
      aggregate: DurableRoomAggregate;
      finalizedAt?: string | null;
      status: RoomStatus;
    } | null,
  ) => {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await recordFor(roomId);
      const next = mutate(current);
      if (!next) return current;
      const updated = await options.repository.compareAndSwap({
        aggregate: next.aggregate,
        expectedVersion: current.version,
        finalizedAt: next.finalizedAt ?? finalizedAt(current),
        roomId,
        status: next.status,
      });
      if (updated) {
        publish(updated);
        return updated;
      }
    }
    throw new RoomServiceError(
      "PICKS_OPEN",
      409,
      "The Room changed; refresh and try again",
    );
  };

  const service = {
    async create(input: {
      fixtureId: string;
      host: { fanId: string; nickname: string; teamCode?: string | undefined };
      name: string;
    }) {
      const sourceFixture = await options.fixture(input.fixtureId);
      if (!sourceFixture) {
        throw new RoomServiceError(
          "FIXTURE_NOT_FOUND",
          404,
          "Fixture not found",
        );
      }
      const createdAt = now();
      const scheduledKickoff = Date.parse(sourceFixture.kickoffAt);
      if (!Number.isFinite(scheduledKickoff)) {
        throw new RoomServiceError(
          "FIXTURE_NOT_FOUND",
          404,
          "Fixture not found",
        );
      }
      if (
        sourceFixture.provenance === "live_txline" &&
        createdAt >= scheduledKickoff
      ) {
        throw new RoomServiceError(
          "ROOM_CREATION_CLOSED",
          409,
          "Room creation is closed after kickoff",
        );
      }
      const kickoffAt =
        sourceFixture.provenance === "synthetic_txline_shaped" &&
        createdAt >= scheduledKickoff
          ? createdAt + 5 * 60_000
          : scheduledKickoff;
      const fixture = {
        ...sourceFixture,
        kickoffAt: new Date(kickoffAt).toISOString(),
      };
      const id = makeRoomId();
      const inviteCode = makeInviteBytes().toString("base64url");
      const room = createRoom({
        createdAt,
        host: { id: input.host.fanId, nickname: input.host.nickname },
        id,
        kickoffAt,
        matchId: fixture.fixtureId,
      });
      const aggregate: DurableRoomAggregate = {
        fixture,
        hostFanId: input.host.fanId,
        ledger: { [input.host.fanId]: senseBalance() },
        lifecycle: [{ at: createdAt, status: "LOBBY" }],
        memberTeamCodes: {
          [input.host.fanId]: input.host.teamCode ?? null,
        },
        name: normalizedRoomName(input.name),
        reactionRecipients: {},
        room,
        schemaVersion: 1,
        senseOutcomes: null,
        sensePhase: "DRAFT",
        senseSlates: {},
        startedAt: null,
        statTotals: { cards: null, corners: null, goals: null },
      };
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
        mode: modeFor(fixture),
        status: "lobby",
      });
      return {
        inviteCode,
        invitePath: `/rooms/join/${inviteCode}`,
        room: buildView(record, input.host.fanId),
      };
    },

    async preview(inviteCode: string): Promise<RoomPreview> {
      const record = await options.repository.previewByInviteHash(
        hashInvite(inviteCode),
      );
      if (!record || Date.parse(record.inviteExpiresAt) <= now()) {
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
        callsLocked: record.status !== "lobby",
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
        status: roomStatus(record.status),
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
        if (!current || Date.parse(current.inviteExpiresAt) <= now()) {
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
        const joinedAt =
          current.status === "lobby"
            ? now()
            : Math.max(now(), current.aggregate.room.kickoffAt);
        const room = joinRoom(current.aggregate.room, {
          joinedAt,
          participant: { id: input.fanId, nickname: input.nickname },
        });
        const role =
          room.members.find(({ id }) => id === input.fanId)?.role === "PLAYER"
            ? "member"
            : "spectator";
        const aggregate: DurableRoomAggregate = {
          ...current.aggregate,
          ledger:
            role === "member"
              ? {
                  ...current.aggregate.ledger,
                  [input.fanId]: senseBalance(),
                }
              : current.aggregate.ledger,
          memberTeamCodes: {
            ...current.aggregate.memberTeamCodes,
            [input.fanId]: input.teamCode ?? null,
          },
          room,
        };
        const updated = await options.repository.joinAndCompareAndSwap({
          aggregate,
          expectedVersion: current.version,
          finalizedAt: finalizedAt(current),
          member: {
            fanId: input.fanId,
            nickname: input.nickname,
            role,
            teamCode: input.teamCode ?? null,
          },
          roomId: current.id,
          status: current.status,
        });
        if (updated) {
          publish(updated);
          return buildView(updated, input.fanId);
        }
      }
      throw new RoomServiceError(
        "PICKS_OPEN",
        409,
        "The Room changed; refresh and try again",
      );
    },

    async get(roomId: string, fanId: string) {
      return buildView(await recordFor(roomId), fanId);
    },

    async list(fanId: string) {
      const records = await options.repository.listForFan(fanId);
      return records.map((record) => buildView(record, fanId));
    },

    async subscribe(
      roomId: string,
      fanId: string,
      listener: (event: RoomStreamEvent) => void,
    ) {
      const record = await recordFor(roomId);
      const room = buildView(record, fanId);
      let roomSubscribers = subscribers.get(roomId);
      if (!roomSubscribers) {
        roomSubscribers = new Map();
        subscribers.set(roomId, roomSubscribers);
      }
      let fanSubscribers = roomSubscribers.get(fanId);
      if (!fanSubscribers) {
        fanSubscribers = new Set();
        roomSubscribers.set(fanId, fanSubscribers);
      }
      fanSubscribers.add(listener);
      listener({
        event: "room.snapshot",
        id: `${record.id}:${record.version + 1}`,
        revision: record.version + 1,
        room,
      });
      return () => {
        fanSubscribers?.delete(listener);
        if (fanSubscribers?.size === 0) roomSubscribers?.delete(fanId);
        if (roomSubscribers?.size === 0) subscribers.delete(roomId);
      };
    },

    async openPicks(roomId: string, fanId: string) {
      const updated = await update(roomId, (current) => {
        if (current.ownerFanId !== fanId) {
          throw new RoomServiceError(
            "DEMO_HOST_REQUIRED",
            403,
            "Only the room host can open picks",
          );
        }
        if (now() >= current.aggregate.room.kickoffAt) {
          throw new RoomServiceError(
            "ROOM_CREATION_CLOSED",
            409,
            "Kickoff has passed, so picks cannot be opened",
          );
        }
        return {
          aggregate: { ...current.aggregate, sensePhase: "OPEN" },
          status: current.status,
        };
      });
      return buildView(updated, fanId);
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
        const recipient = current.aggregate.room.members.find(
          ({ id }) => id === input.recipientParticipantId,
        );
        if (!recipient || input.recipientParticipantId === input.fanId) {
          throw new RoomServiceError(
            "REACTION_RECIPIENT_INVALID",
            400,
            "Reaction recipient must be another room member",
          );
        }
        const reactedAt =
          current.aggregate.startedAt === null
            ? now()
            : Math.max(now(), current.aggregate.room.kickoffAt);
        const result = addReaction(current.aggregate.room, {
          kind: input.kind,
          momentId: input.momentId,
          participantId: input.fanId,
          reactedAt,
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
            ...current.aggregate,
            reactionRecipients: {
              ...current.aggregate.reactionRecipients,
              [result.reaction.id]: input.recipientParticipantId,
            },
            room: result.room,
          },
          status: current.status,
        };
      });
      const room = buildView(updated, input.fanId);
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

    async saveSensePicks(input: {
      fanId: string;
      picks: readonly SensePickInput[];
      roomId: string;
    }) {
      const updated = await update(input.roomId, (current) => {
        const member = current.aggregate.room.members.find(
          ({ id }) => id === input.fanId,
        );
        if (!member) {
          throw new RoomServiceError(
            "ROOM_SESSION_REQUIRED",
            403,
            "This fan is not a Room member",
          );
        }
        if (member.role !== "PLAYER") {
          throw new RoomServiceError(
            "PICKS_NOT_OPEN",
            409,
            "Spectators cannot submit picks",
          );
        }
        if (
          current.status !== "lobby" ||
          current.aggregate.sensePhase !== "OPEN"
        ) {
          throw new RoomServiceError(
            "PICKS_NOT_OPEN",
            409,
            "The host has not opened 100-Sense picks",
          );
        }
        if (now() >= current.aggregate.room.kickoffAt) {
          throw new RoomServiceError(
            "PICKS_NOT_OPEN",
            409,
            "Picks locked at kickoff",
          );
        }
        if (current.aggregate.senseSlates[input.fanId]) {
          throw new RoomServiceError(
            "PICKS_OPEN",
            409,
            "Your 100-Sense picks are already locked",
          );
        }
        const slate = validateSensePicks(input.fanId, input.picks, now());
        return {
          aggregate: {
            ...current.aggregate,
            ledger: {
              ...current.aggregate.ledger,
              [input.fanId]: {
                available: 0,
                committed: STARTING_SENSE,
                returned: null,
                starting: STARTING_SENSE,
              },
            },
            senseSlates: {
              ...current.aggregate.senseSlates,
              [input.fanId]: slate,
            },
          },
          status: current.status,
        };
      });
      return buildView(updated, input.fanId);
    },

    async startExperience(roomId: string, fanId: string) {
      let current = await recordFor(roomId);
      if (current.ownerFanId !== fanId) {
        throw new RoomServiceError(
          "DEMO_HOST_REQUIRED",
          403,
          "Only the room host can start this Experience",
        );
      }
      if (current.aggregate.fixture.provenance !== "synthetic_txline_shaped") {
        throw new RoomServiceError(
          "DEMO_CONTROL_DISABLED",
          409,
          "Real fixtures start from the official match clock",
        );
      }
      if (current.status === "lobby") {
        current = await update(roomId, (record) => ({
          aggregate: {
            ...record.aggregate,
            lifecycle: [
              ...record.aggregate.lifecycle,
              { at: now(), status: "LOCKED" },
            ],
            sensePhase: "LOCKED",
          },
          status: "locked",
        }));
      }
      if (current.status === "locked") {
        const startedFixture = options.startFixture
          ? await options.startFixture({
              fixture: current.aggregate.fixture,
              ownerFanId: fanId,
            })
          : current.aggregate.fixture;
        if (
          startedFixture.fixtureId !== current.aggregate.fixture.fixtureId ||
          startedFixture.provenance !== "synthetic_txline_shaped"
        ) {
          throw new RoomServiceError(
            "DEMO_CONTROL_DISABLED",
            409,
            "Experience start returned a different fixture",
          );
        }
        const kickoffAt = Date.parse(startedFixture.kickoffAt);
        if (!Number.isFinite(kickoffAt)) {
          throw new RoomServiceError(
            "DEMO_CONTROL_DISABLED",
            409,
            "Experience start returned an invalid kickoff",
          );
        }
        current = await update(roomId, (record) => {
          if (record.status !== "locked") return null;
          return {
            aggregate: {
              ...record.aggregate,
              fixture: startedFixture,
              lifecycle: [
                ...record.aggregate.lifecycle,
                { at: now(), status: "LIVE" },
              ],
              room: {
                ...record.aggregate.room,
                kickoffAt,
                status: "LIVE",
              },
              sensePhase: "LIVE",
              startedAt: now(),
            },
            status: "live",
          };
        });
      }
      return buildView(current, fanId);
    },

    async finalise(input: {
      finalisedAt: number;
      fixture: FixtureSnapshot;
      outcomes: SenseOutcomes;
      roomId: string;
    }) {
      const updated = await update(input.roomId, (current) => {
        if (
          current.status === "final" &&
          current.aggregate.fixture.revision >= input.fixture.revision
        ) {
          return null;
        }
        const alreadyFinal = current.status === "final";
        const room = finaliseRoom(current.aggregate.room, {
          event: "game_finalised",
          finalisedAt: input.finalisedAt,
        });
        const leaderboard = scoreSenseSlates({
          members: room.members,
          outcomes: input.outcomes,
          slates: current.aggregate.senseSlates,
        });
        const returnedByFan = new Map(
          leaderboard.map(({ participantId, returnedSense }) => [
            participantId,
            returnedSense,
          ]),
        );
        const ledger = Object.fromEntries(
          Object.entries(current.aggregate.ledger).map(([fanId, entry]) => [
            fanId,
            {
              ...entry,
              returned: returnedByFan.get(fanId) ?? 0,
            },
          ]),
        );
        return {
          aggregate: {
            ...current.aggregate,
            fixture: input.fixture,
            ledger,
            lifecycle: alreadyFinal
              ? current.aggregate.lifecycle
              : [
                  ...current.aggregate.lifecycle,
                  { at: input.finalisedAt, status: "FINAL" },
                ],
            room,
            senseOutcomes: input.outcomes,
            sensePhase: "FINAL",
          },
          finalizedAt: new Date(input.finalisedAt).toISOString(),
          status: "final",
        };
      });
      return buildView(updated, updated.ownerFanId);
    },
  };

  return {
    ...service,
    async projectFixture(fixture: FixtureSnapshot) {
      const records = await options.repository.listByFixture({
        fixtureId: fixture.fixtureId,
        mode: modeFor(fixture),
      });
      for (const record of records) {
        let current = record;
        if (fixture.revision <= current.aggregate.fixture.revision) continue;
        const projectedAt = Math.max(
          now(),
          Date.parse(fixture.updatedAt),
          current.aggregate.room.kickoffAt,
        );
        if (current.status === "final") {
          if (fixture.phase === "full_time") {
            await service.finalise({
              finalisedAt: projectedAt,
              fixture,
              outcomes: outcomesForFixture(fixture),
              roomId: current.id,
            });
          }
          continue;
        }
        current = await update(current.id, (stored) => {
          if (fixture.revision <= stored.aggregate.fixture.revision) {
            return null;
          }
          const startsMatch = fixture.phase !== "scheduled";
          const room = fixture.lastEvent
            ? projectCanonicalMoment(stored.aggregate.room, fixture.lastEvent)
            : stored.aggregate.room;
          const transitionsToLive = startsMatch && stored.status !== "live";
          return {
            aggregate: {
              ...stored.aggregate,
              fixture,
              lifecycle: transitionsToLive
                ? [
                    ...stored.aggregate.lifecycle,
                    ...(stored.status === "lobby"
                      ? [{ at: projectedAt, status: "LOCKED" as const }]
                      : []),
                    { at: projectedAt, status: "LIVE" as const },
                  ]
                : stored.aggregate.lifecycle,
              room: transitionsToLive ? { ...room, status: "LIVE" } : room,
              sensePhase: startsMatch ? "LIVE" : stored.aggregate.sensePhase,
              startedAt: startsMatch
                ? (stored.aggregate.startedAt ?? projectedAt)
                : stored.aggregate.startedAt,
            },
            status: startsMatch ? "live" : stored.status,
          };
        });
        if (current.aggregate.fixture.revision !== fixture.revision) continue;
        if (fixture.phase === "full_time" && current.status !== "final") {
          await service.finalise({
            finalisedAt: projectedAt,
            fixture,
            outcomes: outcomesForFixture(fixture),
            roomId: current.id,
          });
        }
      }
      return records.length;
    },
  };
}

export type DurableRoomService = ReturnType<typeof createDurableRoomService>;
