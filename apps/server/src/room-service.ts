import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  FixtureSnapshot,
  FixtureStreamEvent,
  TeamCode,
} from "@matchsense/contracts";
import {
  CALL_CATEGORIES,
  RoomsDomainError,
  addReaction,
  applyStatRevision,
  createRoom,
  finaliseRoom,
  getLeaderboard,
  joinRoom,
  lockCalls,
  registerMoment,
  resolveMoment,
  setCalls,
  type CallAnswer,
  type CallInput,
  type ReactionKind,
  type RoomState,
} from "@matchsense/rooms";
import type { TxlineCanonicalEvent } from "@matchsense/txline-adapter";

export type RoomServiceErrorCode =
  | "DEMO_CONTROL_DISABLED"
  | "DEMO_HOST_REQUIRED"
  | "DEMO_NOT_STARTED"
  | "FIXTURE_NOT_FOUND"
  | "INVITE_NOT_FOUND"
  | "INVALID_ROOM_NAME"
  | "REACTION_DUPLICATE"
  | "REACTION_MOMENT_OVERTURNED"
  | "REACTION_RECIPIENT_INVALID"
  | "REACTION_RATE_LIMITED"
  | "ROOM_CREATION_CLOSED"
  | "ROOM_NOT_FOUND"
  | "ROOM_SESSION_REQUIRED";

export class RoomServiceError extends Error {
  constructor(
    readonly code: RoomServiceErrorCode,
    readonly statusCode: 400 | 401 | 403 | 404 | 409,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "RoomServiceError";
  }
}

export interface RoomView {
  readonly id: string;
  readonly name: string;
  readonly fixture: FixtureSnapshot;
  readonly kickoffAt: number;
  readonly createdAt: number;
  readonly finalisedAt: number | null;
  readonly revision: number;
  readonly status: "PRE_KICKOFF" | "LIVE" | "FINAL";
  readonly viewerParticipantId: string;
  readonly friendPointsLabel: "FRIEND POINTS · NO PRIZES";
  readonly hostParticipantId: string;
  readonly members: readonly {
    id: string;
    nickname: string;
    role: "PLAYER" | "SPECTATOR";
    joinedAt: number;
    hasCalls: boolean;
    isHost: boolean;
    lockedAt: number | null;
    teamCode: TeamCode | null;
  }[];
  readonly myCalls: RoomState["callSlates"][string] | null;
  readonly leaderboard: readonly (ReturnType<typeof getLeaderboard>[number] & {
    correctCalls: number;
  })[];
  readonly stats: Readonly<
    Record<
      (typeof CALL_CATEGORIES)[number],
      | (NonNullable<RoomState["stats"]["goals"]> & {
          readonly total: number | null;
        })
      | null
    >
  >;
  readonly currentMoment: RoomState["moments"][string] | null;
  readonly moments: readonly RoomState["moments"][string][];
  readonly reactions: readonly RoomReactionView[];
}

export interface RoomReactionView {
  readonly id: string;
  readonly kind: ReactionKind;
  readonly momentId: string;
  readonly reactedAt: number;
  readonly recipientNickname: string;
  readonly recipientParticipantId: string;
  readonly recipientTeamCode: TeamCode | null;
  readonly revision: number;
  readonly senderNickname: string;
  readonly senderParticipantId: string;
  readonly senderTeamCode: TeamCode | null;
  readonly status: "HELD" | "VISIBLE" | "OVERTURNED";
}

export interface RoomPreview {
  readonly fixture: FixtureSnapshot;
  readonly callsLocked: boolean;
  readonly expiresAt: number;
  readonly hostNickname: string;
  readonly kickoffAt: number;
  readonly memberCount: number;
  readonly memberNicknames: readonly string[];
  readonly name: string;
  readonly roomId: string;
  readonly status: RoomView["status"];
}

export interface RoomStreamEvent {
  readonly event: "room.snapshot" | "room.updated";
  readonly id: string;
  readonly revision: number;
  readonly room: RoomView;
}

type RoomSubscriber = (event: RoomStreamEvent) => void;

interface RoomRecord {
  readonly canonicalRevisions: Set<number>;
  readonly expiresAt: number;
  room: RoomState;
  fixture: FixtureSnapshot;
  readonly hostParticipantId: string;
  readonly memberTeamCodes: Map<string, TeamCode | null>;
  readonly name: string;
  readonly reactionRecipients: Map<string, string>;
  revision: number;
  readonly fixtureEventIds: Set<string>;
  startedAt: number | null;
  readonly statTotals: Record<(typeof CALL_CATEGORIES)[number], number | null>;
  readonly subscribers: Map<string, Set<RoomSubscriber>>;
}

export interface RoomServiceOptions {
  readonly fixture: (fixtureId: string) => FixtureSnapshot | null;
  readonly now?: () => number;
  readonly roomId?: () => string;
  readonly inviteBytes?: () => Buffer;
  readonly participantId?: () => string;
  readonly sessionBytes?: () => Buffer;
}

function normalizedRoomName(value: string): string {
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

function capabilityHash(pepper: Buffer, capability: string): string {
  return createHash("sha256")
    .update(pepper)
    .update(capability, "utf8")
    .digest("hex");
}

function effectiveStatus(
  record: RoomRecord,
  observedAt: number,
): RoomView["status"] {
  if (record.room.status === "FINAL") return "FINAL";
  return record.startedAt === null && observedAt < record.room.kickoffAt
    ? record.room.status
    : "LIVE";
}

export function createRoomService(options: RoomServiceOptions) {
  const now = options.now ?? Date.now;
  const makeRoomId = options.roomId ?? randomUUID;
  const makeInviteBytes = options.inviteBytes ?? (() => randomBytes(16));
  const makeParticipantId = options.participantId ?? randomUUID;
  const makeSessionBytes = options.sessionBytes ?? (() => randomBytes(32));
  const invitePepper = randomBytes(32);
  const sessionPepper = randomBytes(32);
  const records = new Map<string, RoomRecord>();
  const roomIdByInviteHash = new Map<string, string>();
  const participantIdBySessionHash = new Map<string, string>();
  const participantIds = new Set<string>();

  const recordFor = (roomId: string): RoomRecord => {
    const record = records.get(roomId);
    if (!record) {
      throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
    }
    return record;
  };

  const recordForInvite = (inviteCode: string): RoomRecord => {
    const roomId = roomIdByInviteHash.get(
      capabilityHash(invitePepper, inviteCode),
    );
    if (!roomId) {
      throw new RoomServiceError(
        "INVITE_NOT_FOUND",
        404,
        "Room invite not found",
      );
    }
    const record = recordFor(roomId);
    if (now() >= record.expiresAt) {
      throw new RoomServiceError(
        "INVITE_NOT_FOUND",
        404,
        "Room invite not found",
      );
    }
    return record;
  };

  const currentFixture = (record: RoomRecord) =>
    options.fixture(record.room.matchId) ?? record.fixture;

  const view = (record: RoomRecord, participantId: string): RoomView => {
    const member = record.room.members.find(({ id }) => id === participantId);
    if (!member) {
      throw new RoomsDomainError(
        "MEMBER_NOT_FOUND",
        "requesting participant is not a room member",
      );
    }
    const moments = Object.values(record.room.moments);
    const reactionViews = record.room.reactions.map((reaction) => {
      const recipientParticipantId = record.reactionRecipients.get(reaction.id);
      const sender = record.room.members.find(
        ({ id }) => id === reaction.participantId,
      );
      const recipient = record.room.members.find(
        ({ id }) => id === recipientParticipantId,
      );
      if (!sender || !recipient || !recipientParticipantId) {
        throw new RoomServiceError(
          "REACTION_RECIPIENT_INVALID",
          400,
          "Reaction recipient is invalid",
        );
      }
      return {
        id: reaction.id,
        kind: reaction.kind,
        momentId: reaction.momentId,
        reactedAt: reaction.reactedAt,
        recipientNickname: recipient.nickname,
        recipientParticipantId,
        recipientTeamCode:
          record.memberTeamCodes.get(recipientParticipantId) ?? null,
        revision: reaction.revision,
        senderNickname: sender.nickname,
        senderParticipantId: reaction.participantId,
        senderTeamCode:
          record.memberTeamCodes.get(reaction.participantId) ?? null,
        status: reaction.status,
      } satisfies RoomReactionView;
    });
    const leaderboard = getLeaderboard(record.room).map((entry) => {
      const slate = record.room.callSlates[entry.participantId];
      const correctCalls = slate
        ? CALL_CATEGORIES.filter((category) => {
            const stat = record.room.stats[category];
            return (
              stat?.state === "RELIABLE" &&
              stat.answer === slate.calls[category].answer
            );
          }).length
        : 0;
      return { ...entry, correctCalls };
    });
    return {
      createdAt: record.room.createdAt,
      currentMoment: moments.at(-1) ?? null,
      finalisedAt: record.room.finalisedAt,
      fixture: currentFixture(record),
      friendPointsLabel: "FRIEND POINTS · NO PRIZES",
      hostParticipantId: record.hostParticipantId,
      id: record.room.id,
      kickoffAt: record.room.kickoffAt,
      leaderboard,
      members: record.room.members.map((roomMember) => {
        const slate = record.room.callSlates[roomMember.id];
        return {
          hasCalls: slate !== undefined,
          id: roomMember.id,
          isHost: roomMember.id === record.hostParticipantId,
          joinedAt: roomMember.joinedAt,
          lockedAt: slate?.lockedAt ?? null,
          nickname: roomMember.nickname,
          role: roomMember.role,
          teamCode: record.memberTeamCodes.get(roomMember.id) ?? null,
        };
      }),
      moments,
      myCalls: record.room.callSlates[member.id] ?? null,
      name: record.name,
      reactions: reactionViews,
      revision: record.revision,
      stats: Object.fromEntries(
        CALL_CATEGORIES.map((category) => {
          const stat = record.room.stats[category];
          return [
            category,
            stat ? { ...stat, total: record.statTotals[category] } : null,
          ];
        }),
      ) as RoomView["stats"],
      status: effectiveStatus(record, now()),
      viewerParticipantId: participantId,
    };
  };

  const publish = (record: RoomRecord) => {
    for (const [participantId, subscribers] of record.subscribers) {
      const event: RoomStreamEvent = {
        event: "room.updated",
        id: `${record.room.id}:${record.revision}`,
        revision: record.revision,
        room: view(record, participantId),
      };
      for (const subscriber of subscribers) subscriber(event);
    }
  };

  const changed = (record: RoomRecord, nextRoom?: RoomState) => {
    if (nextRoom) record.room = nextRoom;
    record.revision += 1;
    publish(record);
  };

  const domainNow = (record: RoomRecord) =>
    record.startedAt === null ? now() : Math.max(now(), record.room.kickoffAt);

  const assertDemo = (record: RoomRecord) => {
    if (record.fixture.provenance !== "synthetic_txline_shaped") {
      throw new RoomServiceError(
        "DEMO_CONTROL_DISABLED",
        409,
        "Demo controls are unavailable for live fixtures",
      );
    }
  };

  const assertDemoHost = (record: RoomRecord, participantId: string) => {
    assertDemo(record);
    if (participantId !== record.hostParticipantId) {
      throw new RoomServiceError(
        "DEMO_HOST_REQUIRED",
        403,
        "Only the room host can control the replay",
      );
    }
  };

  const assertDemoStarted = (record: RoomRecord, participantId: string) => {
    assertDemoHost(record, participantId);
    if (record.startedAt === null) {
      throw new RoomServiceError(
        "DEMO_NOT_STARTED",
        409,
        "Start the demo match before resolving it",
      );
    }
  };

  return {
    openSession(capability?: string) {
      if (capability && /^[A-Za-z0-9_-]{43}$/u.test(capability)) {
        const participantId = participantIdBySessionHash.get(
          capabilityHash(sessionPepper, capability),
        );
        if (participantId) {
          return { capability, isNew: false, participantId } as const;
        }
      }

      let nextCapability = makeSessionBytes().toString("base64url");
      let hashedCapability = capabilityHash(sessionPepper, nextCapability);
      while (participantIdBySessionHash.has(hashedCapability)) {
        nextCapability = makeSessionBytes().toString("base64url");
        hashedCapability = capabilityHash(sessionPepper, nextCapability);
      }
      let participantId = makeParticipantId();
      while (participantIds.has(participantId)) {
        participantId = makeParticipantId();
      }
      participantIds.add(participantId);
      participantIdBySessionHash.set(hashedCapability, participantId);
      return {
        capability: nextCapability,
        isNew: true,
        participantId,
      } as const;
    },

    authenticateSession(capability?: string) {
      if (capability && /^[A-Za-z0-9_-]{43}$/u.test(capability)) {
        const participantId = participantIdBySessionHash.get(
          capabilityHash(sessionPepper, capability),
        );
        if (participantId) return participantId;
      }
      throw new RoomServiceError(
        "ROOM_SESSION_REQUIRED",
        401,
        "Room session is required",
      );
    },

    create(input: {
      fixtureId: string;
      host: {
        participantId: string;
        nickname: string;
        teamCode?: TeamCode | undefined;
      };
      name: string;
    }) {
      const fixture = options.fixture(input.fixtureId);
      if (!fixture) {
        throw new RoomServiceError(
          "FIXTURE_NOT_FOUND",
          404,
          "Fixture not found",
        );
      }
      const createdAt = now();
      const scheduledKickoffAt = Date.parse(fixture.kickoffAt);
      if (!Number.isFinite(scheduledKickoffAt)) {
        throw new RoomServiceError(
          "FIXTURE_NOT_FOUND",
          404,
          "Fixture not found",
        );
      }
      if (
        fixture.provenance === "live_txline" &&
        createdAt >= scheduledKickoffAt
      ) {
        throw new RoomServiceError(
          "ROOM_CREATION_CLOSED",
          409,
          "Room creation is closed after kickoff",
        );
      }
      const kickoffAt =
        fixture.provenance === "synthetic_txline_shaped" &&
        createdAt >= scheduledKickoffAt
          ? createdAt + 5 * 60 * 1_000
          : scheduledKickoffAt;

      let id = makeRoomId();
      while (records.has(id)) id = makeRoomId();
      let inviteCode = makeInviteBytes().toString("base64url");
      let hashedInvite = capabilityHash(invitePepper, inviteCode);
      while (roomIdByInviteHash.has(hashedInvite)) {
        inviteCode = makeInviteBytes().toString("base64url");
        hashedInvite = capabilityHash(invitePepper, inviteCode);
      }
      const room = createRoom({
        createdAt,
        host: {
          id: input.host.participantId,
          nickname: input.host.nickname,
        },
        id,
        kickoffAt,
        matchId: fixture.fixtureId,
      });
      const record: RoomRecord = {
        canonicalRevisions: new Set(),
        expiresAt: kickoffAt + 8 * 60 * 60 * 1_000,
        fixture,
        fixtureEventIds: new Set(),
        hostParticipantId: input.host.participantId,
        memberTeamCodes: new Map([
          [input.host.participantId, input.host.teamCode ?? null],
        ]),
        name: normalizedRoomName(input.name),
        reactionRecipients: new Map(),
        revision: 1,
        room,
        startedAt: null,
        statTotals: { cards: null, corners: null, goals: null },
        subscribers: new Map(),
      };
      records.set(id, record);
      roomIdByInviteHash.set(hashedInvite, id);
      return {
        inviteCode,
        invitePath: `/rooms/join/${inviteCode}`,
        room: view(record, input.host.participantId),
      };
    },

    preview(inviteCode: string): RoomPreview {
      const record = recordForInvite(inviteCode);
      const host = record.room.members.find(
        ({ id }) => id === record.hostParticipantId,
      );
      if (!host) {
        throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
      }
      return {
        callsLocked:
          effectiveStatus(record, now()) !== "PRE_KICKOFF" ||
          now() >= record.room.kickoffAt,
        expiresAt: record.expiresAt,
        fixture: currentFixture(record),
        hostNickname: host.nickname,
        kickoffAt: record.room.kickoffAt,
        memberCount: record.room.members.length,
        memberNicknames: record.room.members.map(({ nickname }) => nickname),
        name: record.name,
        roomId: record.room.id,
        status: effectiveStatus(record, now()),
      };
    },

    join(input: {
      inviteCode: string;
      nickname: string;
      participantId: string;
      teamCode?: TeamCode | undefined;
    }) {
      const record = recordForInvite(input.inviteCode);
      const nextRoom = joinRoom(record.room, {
        joinedAt: domainNow(record),
        participant: {
          id: input.participantId,
          nickname: input.nickname,
        },
      });
      record.memberTeamCodes.set(input.participantId, input.teamCode ?? null);
      changed(record, nextRoom);
      return view(record, input.participantId);
    },

    get(roomId: string, participantId: string) {
      return view(recordFor(roomId), participantId);
    },

    list(participantId: string) {
      return [...records.values()]
        .filter((record) =>
          record.room.members.some(({ id }) => id === participantId),
        )
        .map((record) => view(record, participantId));
    },

    subscribe(
      roomId: string,
      participantId: string,
      subscriber: RoomSubscriber,
    ) {
      const record = recordFor(roomId);
      const initialRoom = view(record, participantId);
      let subscribers = record.subscribers.get(participantId);
      if (!subscribers) {
        subscribers = new Set();
        record.subscribers.set(participantId, subscribers);
      }
      subscribers.add(subscriber);
      subscriber({
        event: "room.snapshot",
        id: `${roomId}:${record.revision}`,
        revision: record.revision,
        room: initialRoom,
      });
      return () => {
        subscribers?.delete(subscriber);
        if (subscribers?.size === 0) record.subscribers.delete(participantId);
      };
    },

    saveCalls(input: {
      roomId: string;
      participantId: string;
      calls: readonly CallInput[];
      lock: boolean;
    }) {
      const record = recordFor(input.roomId);
      const at = domainNow(record);
      let nextRoom = setCalls(record.room, {
        calls: input.calls,
        changedAt: at,
        participantId: input.participantId,
      });
      if (input.lock) {
        nextRoom = lockCalls(nextRoom, {
          lockedAt: at,
          participantId: input.participantId,
        });
      }
      changed(record, nextRoom);
      return view(record, input.participantId);
    },

    react(input: {
      roomId: string;
      participantId: string;
      momentId: string;
      revision: number;
      kind: ReactionKind;
      recipientParticipantId: string;
    }) {
      const record = recordFor(input.roomId);
      const recipient = record.room.members.find(
        ({ id }) => id === input.recipientParticipantId,
      );
      if (!recipient || input.recipientParticipantId === input.participantId) {
        throw new RoomServiceError(
          "REACTION_RECIPIENT_INVALID",
          400,
          "Reaction recipient must be another room member",
        );
      }
      const result = addReaction(record.room, {
        kind: input.kind,
        momentId: input.momentId,
        participantId: input.participantId,
        reactedAt: domainNow(record),
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
      record.reactionRecipients.set(
        result.reaction.id,
        input.recipientParticipantId,
      );
      changed(record, result.room);
      const room = view(record, input.participantId);
      const reaction = room.reactions.find(
        ({ id }) => id === result.reaction?.id,
      );
      if (!reaction) {
        throw new RoomServiceError(
          "REACTION_RECIPIENT_INVALID",
          400,
          "Reaction recipient is invalid",
        );
      }
      return {
        reaction,
        room,
      };
    },

    applyCanonicalEvent(event: TxlineCanonicalEvent) {
      const observedAt = Date.parse(event.receivedAt);
      if (!Number.isFinite(observedAt)) return 0;
      let applied = 0;
      for (const record of records.values()) {
        if (
          record.room.matchId !== event.fixtureId ||
          record.room.status === "FINAL" ||
          record.canonicalRevisions.has(event.revision)
        ) {
          continue;
        }
        record.canonicalRevisions.add(event.revision);
        const domainObservedAt = Math.max(observedAt, record.room.kickoffAt);
        let nextRoom = record.room;
        let changedByEvent = false;
        if (record.startedAt === null && observedAt >= record.room.kickoffAt) {
          record.startedAt = observedAt;
          changedByEvent = true;
        }
        if (event.confirmed === true && event.participantStats !== null) {
          const first = event.participantStats.participant1;
          const second = event.participantStats.participant2;
          const totals = {
            cards:
              first.yellowCards +
              first.redCards +
              second.yellowCards +
              second.redCards,
            corners: first.corners + second.corners,
            goals: first.goals + second.goals,
          } as const;
          const thresholds = { cards: 5, corners: 10, goals: 3 } as const;
          for (const category of CALL_CATEGORIES) {
            nextRoom = applyStatRevision(nextRoom, {
              answer: totals[category] >= thresholds[category] ? "YES" : "NO",
              category,
              observedAt: domainObservedAt,
              revision: event.revision,
            });
            record.statTotals[category] = totals[category];
          }
          changedByEvent = true;
        }
        if (event.action === "game_finalised" && event.confirmed === true) {
          nextRoom = finaliseRoom(nextRoom, {
            event: "game_finalised",
            finalisedAt: domainObservedAt,
          });
          changedByEvent = true;
        }
        if (changedByEvent) {
          changed(record, nextRoom);
          applied += 1;
        }
      }
      return applied;
    },

    applyFixtureEvent(event: FixtureStreamEvent) {
      if (
        (event.event !== "moment.created" &&
          event.event !== "moment.revised") ||
        !event.moment
      ) {
        return 0;
      }
      const observedAt = Date.parse(event.snapshot.updatedAt);
      let applied = 0;
      for (const record of records.values()) {
        if (
          record.room.matchId !== event.snapshot.fixtureId ||
          record.room.status === "FINAL" ||
          record.fixtureEventIds.has(event.id)
        ) {
          continue;
        }
        record.fixtureEventIds.add(event.id);
        record.fixture = event.snapshot;
        const domainObservedAt = Math.max(
          Number.isFinite(observedAt) ? observedAt : now(),
          record.room.kickoffAt,
        );
        record.startedAt ??= domainObservedAt;
        let nextRoom = registerMoment(record.room, {
          momentId: event.moment.id,
          revision: event.moment.revision,
          varState: "CLEAR",
        });
        if (event.snapshot.provenance === "synthetic_txline_shaped") {
          const total = event.snapshot.score.home + event.snapshot.score.away;
          nextRoom = applyStatRevision(nextRoom, {
            answer: total >= 3 ? "YES" : "NO",
            category: "goals",
            observedAt: domainObservedAt,
            revision: event.moment.revision,
          });
          record.statTotals.goals = total;
        }
        changed(record, nextRoom);
        applied += 1;
      }
      return applied;
    },

    startDemo(roomId: string, participantId: string) {
      const record = recordFor(roomId);
      assertDemoHost(record, participantId);
      if (record.startedAt === null) {
        record.startedAt = now();
        changed(record);
      }
      return view(record, participantId);
    },

    resolveDemoStats(input: {
      roomId: string;
      participantId: string;
      revision: number;
      goals: CallAnswer;
      cards: CallAnswer;
      corners: CallAnswer;
    }) {
      const record = recordFor(input.roomId);
      assertDemoStarted(record, input.participantId);
      let nextRoom = record.room;
      const thresholds = { cards: 5, corners: 10, goals: 3 } as const;
      for (const category of ["goals", "cards", "corners"] as const) {
        nextRoom = applyStatRevision(nextRoom, {
          answer: input[category],
          category,
          observedAt: domainNow(record),
          revision: input.revision,
        });
        record.statTotals[category] =
          input[category] === "YES"
            ? thresholds[category]
            : thresholds[category] - 1;
      }
      changed(record, nextRoom);
      return view(record, input.participantId);
    },

    registerDemoMoment(input: {
      roomId: string;
      participantId: string;
      momentId: string;
      revision: number;
      varState: "CLEAR" | "HOLD";
    }) {
      const record = recordFor(input.roomId);
      assertDemoStarted(record, input.participantId);
      changed(
        record,
        registerMoment(record.room, {
          momentId: input.momentId,
          revision: input.revision,
          varState: input.varState,
        }),
      );
      return view(record, input.participantId);
    },

    resolveDemoMoment(input: {
      roomId: string;
      participantId: string;
      momentId: string;
      revision: number;
      resolution: "CONFIRMED" | "OVERTURNED";
    }) {
      const record = recordFor(input.roomId);
      assertDemoStarted(record, input.participantId);
      changed(
        record,
        resolveMoment(record.room, {
          momentId: input.momentId,
          resolution: input.resolution,
          revision: input.revision,
        }),
      );
      return view(record, input.participantId);
    },

    finaliseDemo(roomId: string, participantId: string) {
      const record = recordFor(roomId);
      assertDemoStarted(record, participantId);
      changed(
        record,
        finaliseRoom(record.room, {
          event: "game_finalised",
          finalisedAt: domainNow(record),
        }),
      );
      return view(record, participantId);
    },
  };
}

export type RoomService = ReturnType<typeof createRoomService>;
