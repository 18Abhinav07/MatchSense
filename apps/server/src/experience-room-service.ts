import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  RoomAggregateRecord,
  RoomAggregateRepository,
  RoomStatus,
} from "@matchsense/db";
import type { FixtureSnapshot, TeamCode } from "@matchsense/contracts";
import {
  RoomsDomainError,
  addCallThreeReaction,
  confirmHeldCallThreeMoment,
  createExperienceCallThreeRoom,
  finaliseCallThreeRoom,
  getCallThreeLeaderboard,
  holdCallThreeMoment,
  joinCallThreeRoom,
  lockCallThreeCalls,
  overturnCallThreeMoment,
  projectCallThreeRoom,
  registerConfirmedCallThreeMoment,
  setCallThreeCalls,
  startExperienceCallThreeRoom,
  supersedeCallThreeMoment,
  type CallThreeInput,
  type CallThreeRoomState,
  type MomentRevision,
  type ReactionKind,
  type RoomReaction,
} from "@matchsense/rooms";

import { RoomServiceError } from "./room-service.js";

const MAX_CAS_ATTEMPTS = 4;
export const EXPERIENCE_ROOM_LABEL =
  "EXPERIENCE · SIMULATED TXLINE-SHAPED DATA" as const;

export interface ExperienceRoomAggregate {
  readonly demoSupporterIds: readonly string[];
  readonly experience: {
    readonly label: typeof EXPERIENCE_ROOM_LABEL;
    readonly lobbyDeadlineAt: number;
    readonly provenance: "synthetic_txline_shaped";
    readonly runId: string;
    readonly startedAt: number | null;
  };
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
  readonly schemaVersion: 3;
}

export interface ExperienceRoomReactionView {
  readonly id: string;
  readonly kind: ReactionKind;
  readonly momentId: string;
  readonly reactedAt: number;
  readonly recipientNickname: string;
  readonly recipientParticipantId: string;
  readonly revision: number;
  readonly senderNickname: string;
  readonly senderParticipantId: string;
  readonly status: "HELD" | "VISIBLE" | "OVERTURNED";
}

export interface ExperienceRoomView {
  readonly createdAt: number;
  readonly currentMoment: MomentRevision | null;
  readonly experience: ExperienceRoomAggregate["experience"];
  readonly finalisedAt: number | null;
  readonly fixture: FixtureSnapshot;
  readonly friendPointsLabel: "MATCHSENSE POINTS · NO PRIZES";
  readonly hostParticipantId: string;
  readonly id: string;
  readonly kickoffAt: number;
  readonly leaderboard: ReturnType<typeof getCallThreeLeaderboard>;
  readonly members: readonly {
    readonly hasCalls: boolean;
    readonly id: string;
    readonly isDemoSupporter: boolean;
    readonly isHost: boolean;
    readonly joinedAt: number;
    readonly lockedAt: number | null;
    readonly nickname: string;
    readonly role: "PLAYER" | "SPECTATOR";
    readonly teamCode: string | null;
  }[];
  readonly moments: readonly MomentRevision[];
  readonly myCalls: CallThreeRoomState["callSlates"][string] | null;
  readonly name: string;
  readonly reactions: readonly ExperienceRoomReactionView[];
  readonly revision: number;
  readonly status: "PRE_KICKOFF" | "LIVE" | "FINAL";
  readonly targets: CallThreeRoomState["targets"];
  readonly viewerParticipantId: string;
}

export interface ExperienceRoomPreview {
  readonly callsLocked: boolean;
  readonly experience: ExperienceRoomAggregate["experience"];
  readonly expiresAt: number;
  readonly fixture: FixtureSnapshot;
  readonly hostNickname: string;
  readonly memberCount: number;
  readonly memberNicknames: readonly string[];
  readonly name: string;
  readonly roomId: string;
  readonly status: ExperienceRoomView["status"];
}

export interface ExperienceRoomStreamEvent {
  readonly event: "room.snapshot" | "room.updated";
  readonly id: string;
  readonly revision: number;
  readonly room: ExperienceRoomView;
}

export interface ExperienceRoomServiceOptions {
  readonly activateFixture?: (fixtureId: string) => void;
  readonly inviteBytes?: () => Buffer;
  readonly lobbyMs?: number;
  readonly now?: () => number;
  prepareFixture(input: {
    awayTeam: TeamCode;
    homeTeam: TeamCode;
    ownerFanId: string;
  }): Promise<{ fixture: FixtureSnapshot; runId: string }>;
  readonly repository: RoomAggregateRepository<ExperienceRoomAggregate>;
  readonly roomId?: () => string;
  startFixture(input: {
    fixture: FixtureSnapshot;
    ownerFanId: string;
    runId: string;
  }): Promise<FixtureSnapshot>;
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

function isExperienceAggregate(
  value: unknown,
): value is ExperienceRoomAggregate {
  if (!value || typeof value !== "object") return false;
  const aggregate = value as Partial<ExperienceRoomAggregate>;
  return (
    aggregate.schemaVersion === 3 &&
    aggregate.experience?.provenance === "synthetic_txline_shaped" &&
    aggregate.experience.label === EXPERIENCE_ROOM_LABEL &&
    aggregate.fixture?.provenance === "synthetic_txline_shaped" &&
    !!aggregate.room
  );
}

function requireAggregate(
  record: RoomAggregateRecord<ExperienceRoomAggregate>,
) {
  if (record.mode !== "demo" || !isExperienceAggregate(record.aggregate)) {
    throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
  }
  return record.aggregate;
}

function roomStatus(status: RoomStatus): ExperienceRoomView["status"] {
  if (status === "final") return "FINAL";
  if (status === "live") return "LIVE";
  return "PRE_KICKOFF";
}

function finalisedAt(record: RoomAggregateRecord<ExperienceRoomAggregate>) {
  const value = requireAggregate(record).room.finalisedAt;
  return value === null ? null : new Date(value).toISOString();
}

function reactionView(
  aggregate: ExperienceRoomAggregate,
  reaction: RoomReaction,
): ExperienceRoomReactionView | null {
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
    revision: reaction.revision,
    senderNickname: sender.nickname,
    senderParticipantId: sender.id,
    status:
      reaction.status === "OVERTURNED"
        ? "OVERTURNED"
        : reaction.status === "HELD"
          ? "HELD"
          : "VISIBLE",
  };
}

function buildView(
  record: RoomAggregateRecord<ExperienceRoomAggregate>,
  fanId: string,
): ExperienceRoomView {
  const aggregate = requireAggregate(record);
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
  return {
    createdAt: aggregate.room.createdAt,
    currentMoment: moments.at(-1) ?? null,
    experience: aggregate.experience,
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
      isDemoSupporter: aggregate.demoSupporterIds.includes(roomMember.id),
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
    reactions: aggregate.room.reactions.flatMap((reaction) => {
      const view = reactionView(aggregate, reaction);
      return view ? [view] : [];
    }),
    revision: record.version + 1,
    status: roomStatus(record.status),
    targets: aggregate.room.targets,
    viewerParticipantId: fanId,
  };
}

function appendLifecycle(
  lifecycle: ExperienceRoomAggregate["lifecycle"],
  entry: ExperienceRoomAggregate["lifecycle"][number],
) {
  return lifecycle.at(-1)?.status === entry.status
    ? lifecycle
    : [...lifecycle, entry];
}

function projectCanonicalMoment(
  room: CallThreeRoomState,
  moment: NonNullable<FixtureSnapshot["lastEvent"]>,
) {
  if (moment.kind === "var.started") {
    return holdCallThreeMoment(room, {
      momentId: moment.id,
      revision: moment.revision,
    });
  }
  if (moment.kind === "var.stands") {
    return confirmHeldCallThreeMoment(room, {
      momentId: moment.id,
      revision: moment.revision,
    });
  }
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
  return moment.status === "confirmed"
    ? registerConfirmedCallThreeMoment(room, {
        momentId: moment.id,
        revision: moment.revision,
      })
    : room;
}

function regulationResult(
  fixture: FixtureSnapshot,
): "HOME" | "DRAW" | "AWAY" | null {
  const score = fixture.scores?.regulation ?? fixture.score;
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

function isExperienceFinal(fixture: FixtureSnapshot) {
  return (
    fixture.provenance === "synthetic_txline_shaped" &&
    fixture.phase === "full_time" &&
    fixture.lastEvent?.kind === "phase.full_time" &&
    fixture.lastEvent.status === "confirmed"
  );
}

export async function experienceRoomFanIdsForRun(
  repository: RoomAggregateRepository<ExperienceRoomAggregate>,
  runId: string,
) {
  const records = (await repository.listByMode?.("demo")) ?? [];
  return [
    ...new Set(
      records.flatMap((record) => {
        if (
          !isExperienceAggregate(record.aggregate) ||
          record.aggregate.experience.runId !== runId
        ) {
          return [];
        }
        const supporters = new Set(record.aggregate.demoSupporterIds);
        return record.aggregate.room.members
          .filter(({ id }) => !supporters.has(id))
          .map(({ id }) => id);
      }),
    ),
  ];
}

export function createExperienceRoomService(
  options: ExperienceRoomServiceOptions,
) {
  const now = options.now ?? Date.now;
  const lobbyMs = options.lobbyMs ?? 5 * 60_000;
  const makeRoomId = options.roomId ?? randomUUID;
  const makeInviteBytes = options.inviteBytes ?? (() => randomBytes(16));
  const subscribers = new Map<
    string,
    Map<string, Set<(event: ExperienceRoomStreamEvent) => void>>
  >();
  const activeRoomIds = new Set<string>();
  const startLocks = new Map<string, Promise<ExperienceRoomView>>();

  const recordFor = async (roomId: string) => {
    const record = await options.repository.get(roomId);
    if (!record || !isExperienceAggregate(record.aggregate)) {
      throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
    }
    activeRoomIds.add(record.id);
    options.activateFixture?.(record.fixtureId);
    return record;
  };

  const publish = async (
    record: RoomAggregateRecord<ExperienceRoomAggregate>,
  ) => {
    const roomSubscribers = subscribers.get(record.id);
    if (!roomSubscribers) return;
    for (const [fanId, listeners] of roomSubscribers) {
      const event: ExperienceRoomStreamEvent = {
        event: "room.updated",
        id: `${record.id}:${record.version + 1}`,
        revision: record.version + 1,
        room: buildView(record, fanId),
      };
      for (const listener of listeners) listener(event);
    }
  };

  type Mutation = {
    aggregate: ExperienceRoomAggregate;
    finalizedAt?: string | null;
    status: RoomStatus;
  };

  const update = async (
    roomId: string,
    mutate: (
      record: RoomAggregateRecord<ExperienceRoomAggregate>,
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

  const startRoom = async (
    roomId: string,
    fanId: string | null,
    automatic: boolean,
  ): Promise<ExperienceRoomView> => {
    const pending = startLocks.get(roomId);
    if (pending) return pending;
    const operation = (async () => {
      const current = await recordFor(roomId);
      const aggregate = requireAggregate(current);
      if (aggregate.room.status !== "PRE_KICKOFF") {
        return buildView(current, fanId ?? aggregate.hostFanId);
      }
      if (!automatic && fanId !== aggregate.hostFanId) {
        throw new RoomServiceError(
          "DEMO_HOST_REQUIRED",
          403,
          "Only the Room host can start the Experience early",
        );
      }
      const allPlayersLocked = aggregate.room.members
        .filter(({ role }) => role === "PLAYER")
        .every(
          ({ id }) =>
            aggregate.room.callSlates[id]?.lockedAt !== null &&
            aggregate.room.callSlates[id] !== undefined,
        );
      if (!automatic && !allPlayersLocked) {
        throw new RoomServiceError(
          "EXPERIENCE_NOT_READY",
          409,
          "Every joined player must lock Call Three before an early start",
        );
      }
      const fixture = await options.startFixture({
        fixture: aggregate.fixture,
        ownerFanId: aggregate.hostFanId,
        runId: aggregate.experience.runId,
      });
      if (
        fixture.fixtureId !== aggregate.fixture.fixtureId ||
        fixture.provenance !== "synthetic_txline_shaped"
      ) {
        throw new Error("Experience start returned a mismatched fixture");
      }
      const parsedKickoff = Date.parse(fixture.kickoffAt);
      const startedAt = Number.isFinite(parsedKickoff) ? parsedKickoff : now();
      const updated = await update(roomId, (latest) => {
        const latestAggregate = requireAggregate(latest);
        if (latestAggregate.room.status !== "PRE_KICKOFF") return null;
        return {
          aggregate: {
            ...latestAggregate,
            experience: {
              ...latestAggregate.experience,
              startedAt,
            },
            fixture,
            lifecycle: appendLifecycle(latestAggregate.lifecycle, {
              at: startedAt,
              status: "LIVE",
            }),
            room: startExperienceCallThreeRoom(latestAggregate.room, {
              observedAt: startedAt,
            }),
          },
          status: "live",
        };
      });
      return buildView(updated, fanId ?? aggregate.hostFanId);
    })().finally(() => startLocks.delete(roomId));
    startLocks.set(roomId, operation);
    return operation;
  };

  const ensureDeadline = async (
    record: RoomAggregateRecord<ExperienceRoomAggregate>,
  ) => {
    const aggregate = requireAggregate(record);
    return aggregate.room.status === "PRE_KICKOFF" &&
      now() >= aggregate.experience.lobbyDeadlineAt
      ? startRoom(record.id, aggregate.hostFanId, true)
      : null;
  };

  const service = {
    async recover() {
      const records =
        (await options.repository.listByMode?.("demo")) ?? ([] as const);
      for (const record of records) {
        if (!isExperienceAggregate(record.aggregate)) continue;
        activeRoomIds.add(record.id);
        options.activateFixture?.(record.fixtureId);
      }
      await service.tick();
      return activeRoomIds.size;
    },

    async isRunMember(runId: string, fanId: string) {
      const records = await options.repository.listForFan(fanId);
      return records.some(
        (record) =>
          isExperienceAggregate(record.aggregate) &&
          record.mode === "demo" &&
          record.aggregate.experience.runId === runId &&
          record.aggregate.room.members.some(({ id }) => id === fanId),
      );
    },

    async create(input: {
      addDemoSupporters?: boolean;
      awayTeam: TeamCode;
      homeTeam: TeamCode;
      host: { fanId: string; nickname: string; teamCode?: string };
      name: string;
    }) {
      const createdAt = now();
      const prepared = await options.prepareFixture({
        awayTeam: input.awayTeam,
        homeTeam: input.homeTeam,
        ownerFanId: input.host.fanId,
      });
      if (
        prepared.fixture.provenance !== "synthetic_txline_shaped" ||
        prepared.fixture.fixtureId !== `experience:${prepared.runId}`
      ) {
        throw new Error("Experience preparation returned an invalid fixture");
      }
      const lobbyDeadlineAt = createdAt + lobbyMs;
      const fixture = {
        ...prepared.fixture,
        kickoffAt: new Date(lobbyDeadlineAt).toISOString(),
      };
      const id = makeRoomId();
      const inviteCode = makeInviteBytes().toString("base64url");
      let room = createExperienceCallThreeRoom({
        createdAt,
        fixture: {
          fixtureId: fixture.fixtureId,
          kickoffAt: lobbyDeadlineAt,
          provenance: "synthetic_txline_shaped",
        },
        host: { id: input.host.fanId, nickname: input.host.nickname },
        id,
      });
      const demoSupporterIds: string[] = [];
      if (input.addDemoSupporters) {
        const supporters = [
          {
            calls: [
              {
                answer: "HOME" as const,
                confidence: 1 as const,
                target: "result" as const,
              },
              {
                answer: "YES" as const,
                confidence: 2 as const,
                target: "goals" as const,
              },
              {
                answer: "YES" as const,
                confidence: 3 as const,
                target: "cards" as const,
              },
            ],
            id: `experience-supporter:${id}:maya`,
            nickname: "Maya",
            teamCode: input.homeTeam,
          },
          {
            calls: [
              {
                answer: "AWAY" as const,
                confidence: 2 as const,
                target: "result" as const,
              },
              {
                answer: "NO" as const,
                confidence: 3 as const,
                target: "goals" as const,
              },
              {
                answer: "YES" as const,
                confidence: 1 as const,
                target: "cards" as const,
              },
            ],
            id: `experience-supporter:${id}:leo`,
            nickname: "Leo",
            teamCode: input.awayTeam,
          },
        ] as const;
        for (const [index, supporter] of supporters.entries()) {
          const joinedAt = createdAt + index + 1;
          room = joinCallThreeRoom(room, {
            joinedAt,
            participant: { id: supporter.id, nickname: supporter.nickname },
          });
          room = setCallThreeCalls(room, {
            calls: supporter.calls,
            changedAt: joinedAt,
            participantId: supporter.id,
          });
          room = lockCallThreeCalls(room, {
            lockedAt: joinedAt,
            participantId: supporter.id,
          });
          demoSupporterIds.push(supporter.id);
        }
      }
      const aggregate: ExperienceRoomAggregate = {
        demoSupporterIds,
        experience: {
          label: EXPERIENCE_ROOM_LABEL,
          lobbyDeadlineAt,
          provenance: "synthetic_txline_shaped",
          runId: prepared.runId,
          startedAt: null,
        },
        fixture,
        hostFanId: input.host.fanId,
        lifecycle: [{ at: createdAt, status: "LOBBY" }],
        memberTeamCodes: {
          [input.host.fanId]: input.host.teamCode ?? null,
          ...(input.addDemoSupporters
            ? {
                [`experience-supporter:${id}:leo`]: input.awayTeam,
                [`experience-supporter:${id}:maya`]: input.homeTeam,
              }
            : {}),
        },
        name: normalizedRoomName(input.name),
        reactionRecipients: {},
        room,
        schemaVersion: 3,
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
        inviteExpiresAt: new Date(
          lobbyDeadlineAt + 8 * 60 * 60_000,
        ).toISOString(),
        inviteHash: hashInvite(inviteCode),
        mode: "demo",
        status: "lobby",
      });
      activeRoomIds.add(id);
      return {
        inviteCode,
        invitePath: `/experience/rooms/join/${inviteCode}`,
        room: buildView(record, input.host.fanId),
      };
    },

    async preview(inviteCode: string): Promise<ExperienceRoomPreview> {
      const record = await options.repository.previewByInviteHash(
        hashInvite(inviteCode),
      );
      if (
        !record ||
        !isExperienceAggregate(record.aggregate) ||
        Date.parse(record.inviteExpiresAt) <= now()
      ) {
        throw new RoomServiceError(
          "INVITE_NOT_FOUND",
          404,
          "Experience Room invite not found",
        );
      }
      await ensureDeadline(record);
      const current = await recordFor(record.id);
      const aggregate = requireAggregate(current);
      const host = aggregate.room.members.find(
        ({ id }) => id === aggregate.hostFanId,
      );
      if (!host)
        throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
      return {
        callsLocked: aggregate.room.status !== "PRE_KICKOFF",
        experience: aggregate.experience,
        expiresAt: Date.parse(current.inviteExpiresAt),
        fixture: aggregate.fixture,
        hostNickname: host.nickname,
        memberCount: aggregate.room.members.length,
        memberNicknames: aggregate.room.members.map(({ nickname }) => nickname),
        name: aggregate.name,
        roomId: current.id,
        status: roomStatus(current.status),
      };
    },

    async join(input: {
      fanId: string;
      inviteCode: string;
      nickname: string;
      teamCode?: string;
    }) {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const candidate = await options.repository.previewByInviteHash(
          hashInvite(input.inviteCode),
        );
        if (
          !candidate ||
          !isExperienceAggregate(candidate.aggregate) ||
          Date.parse(candidate.inviteExpiresAt) <= now()
        ) {
          throw new RoomServiceError(
            "INVITE_NOT_FOUND",
            404,
            "Experience Room invite not found",
          );
        }
        await ensureDeadline(candidate);
        const current = await recordFor(candidate.id);
        const aggregate = requireAggregate(current);
        if (aggregate.room.members.length >= 20) {
          throw new RoomServiceError(
            "ROOM_FULL",
            409,
            "This room already has its maximum of 20 fans",
          );
        }
        const joinedAt =
          aggregate.room.status === "PRE_KICKOFF"
            ? now()
            : Math.max(now(), aggregate.room.kickoffAt);
        const room = joinCallThreeRoom(aggregate.room, {
          joinedAt,
          participant: { id: input.fanId, nickname: input.nickname },
        });
        const joined = room.members.find(({ id }) => id === input.fanId);
        if (!joined)
          throw new RoomServiceError("ROOM_NOT_FOUND", 404, "Room not found");
        const status: RoomStatus =
          room.status === "FINAL"
            ? "final"
            : room.status === "LIVE"
              ? "live"
              : "lobby";
        const nextAggregate: ExperienceRoomAggregate = {
          ...aggregate,
          memberTeamCodes: {
            ...aggregate.memberTeamCodes,
            [input.fanId]: input.teamCode ?? null,
          },
          room,
        };
        const updated = await options.repository.joinAndCompareAndSwap({
          aggregate: nextAggregate,
          expectedVersion: current.version,
          finalizedAt: finalisedAt(current),
          member: {
            fanId: input.fanId,
            nickname: input.nickname,
            role: joined.role === "PLAYER" ? "member" : "spectator",
            teamCode: input.teamCode ?? null,
          },
          roomId: current.id,
          status,
        });
        if (updated) {
          activeRoomIds.add(updated.id);
          await publish(updated);
          return buildView(updated, input.fanId);
        }
      }
      throw new RoomsDomainError(
        "REVISION_CONFLICT",
        "The Room changed; refresh and try again",
      );
    },

    async get(roomId: string, fanId: string) {
      const record = await recordFor(roomId);
      await ensureDeadline(record);
      return buildView(await recordFor(roomId), fanId);
    },

    async list(fanId: string) {
      const records = await options.repository.listForFan(fanId);
      const views: ExperienceRoomView[] = [];
      for (const record of records) {
        if (!isExperienceAggregate(record.aggregate)) continue;
        activeRoomIds.add(record.id);
        await ensureDeadline(record);
        views.push(buildView(await recordFor(record.id), fanId));
      }
      return views;
    },

    async subscribe(
      roomId: string,
      fanId: string,
      listener: (event: ExperienceRoomStreamEvent) => void,
    ) {
      const record = await recordFor(roomId);
      await ensureDeadline(record);
      const current = await recordFor(roomId);
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
        id: `${current.id}:${current.version + 1}`,
        revision: current.version + 1,
        room: buildView(current, fanId),
      });
      return () => {
        fanSubscribers?.delete(listener);
        if (fanSubscribers?.size === 0) roomSubscribers?.delete(fanId);
        if (roomSubscribers?.size === 0) subscribers.delete(roomId);
      };
    },

    async setCalls(input: {
      calls: readonly CallThreeInput[];
      fanId: string;
      roomId: string;
    }) {
      const updated = await update(input.roomId, (current) => {
        const aggregate = requireAggregate(current);
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
      return buildView(updated, input.fanId);
    },

    async lockCalls(input: { fanId: string; roomId: string }) {
      const updated = await update(input.roomId, (current) => {
        const aggregate = requireAggregate(current);
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
      return buildView(updated, input.fanId);
    },

    start(input: { fanId: string; roomId: string }) {
      return startRoom(input.roomId, input.fanId, false);
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
        const aggregate = requireAggregate(current);
        const recipient = aggregate.room.members.find(
          ({ id }) => id === input.recipientParticipantId,
        );
        if (!recipient || recipient.id === input.fanId) {
          throw new RoomServiceError(
            "REACTION_RECIPIENT_INVALID",
            400,
            "Reaction recipient must be another Room member",
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
      const room = buildView(updated, input.fanId);
      const reaction = room.reactions.find(
        ({ momentId, revision, senderParticipantId }) =>
          momentId === input.momentId &&
          revision === input.revision &&
          senderParticipantId === input.fanId,
      );
      if (!reaction)
        throw new RoomServiceError(
          "REACTION_RECIPIENT_INVALID",
          400,
          "Reaction is invalid",
        );
      return { reaction, room };
    },

    async projectFixture(fixture: FixtureSnapshot) {
      if (fixture.provenance !== "synthetic_txline_shaped") return 0;
      const records = await options.repository.listByFixture({
        fixtureId: fixture.fixtureId,
        mode: "demo",
      });
      let projected = 0;
      for (const candidate of records) {
        if (!isExperienceAggregate(candidate.aggregate)) continue;
        const before = candidate.version;
        const updated = await update(candidate.id, (current) => {
          const aggregate = requireAggregate(current);
          if (fixture.revision <= aggregate.fixture.revision) return null;
          let room = aggregate.room;
          if (room.status === "PRE_KICKOFF" && fixture.phase !== "scheduled") {
            room = startExperienceCallThreeRoom(room, {
              observedAt: aggregate.experience.startedAt ?? now(),
            });
          }
          if (room.status !== "FINAL" && fixture.lastEvent) {
            room = projectCanonicalMoment(room, fixture.lastEvent);
          }
          if (
            room.status !== "FINAL" &&
            fixture.phase !== "scheduled" &&
            fixture.revision > 0
          ) {
            const observedAt = Math.max(
              aggregate.experience.startedAt ?? room.kickoffAt,
              Date.parse(fixture.updatedAt) || now(),
            );
            room = projectCallThreeRoom(room, {
              observedAt,
              regulationResult: regulationResult(fixture) ?? "DRAW",
              totalCards: cardTotal(fixture),
              totalGoals: fixture.score.home + fixture.score.away,
              version: fixture.revision,
            });
          }
          let status: RoomStatus = room.status === "LIVE" ? "live" : "lobby";
          let finalizedAtValue: string | null | undefined;
          if (isExperienceFinal(fixture)) {
            const observedAt = Math.max(
              now(),
              Date.parse(fixture.updatedAt) || now(),
              room.kickoffAt,
            );
            room = finaliseCallThreeRoom(room, {
              facts: {
                finalisedAt: observedAt,
                regulationResult: regulationResult(fixture),
                totalCards: cardTotal(fixture),
                totalGoals: fixture.score.home + fixture.score.away,
                verified: true,
                version: fixture.revision,
              },
            });
            status = "final";
            finalizedAtValue = new Date(
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
                at: Math.max(now(), room.kickoffAt),
                status: lifecycleStatus,
              }),
              room,
            },
            ...(finalizedAtValue === undefined
              ? {}
              : { finalizedAt: finalizedAtValue }),
            status,
          };
        });
        if (updated.version > before) projected += 1;
      }
      return projected;
    },

    async tick() {
      for (const roomId of activeRoomIds) {
        const record = await recordFor(roomId);
        await ensureDeadline(record);
      }
    },
  };

  return service;
}

export type ExperienceRoomService = ReturnType<
  typeof createExperienceRoomService
>;
