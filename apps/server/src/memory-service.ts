import type {
  ExperienceRunRecord,
  FanFollowRecord,
  FixtureEventRecord,
  FixtureProjectionRecord,
  FixtureRecord,
  MemoryRecord,
  MemoryRepository,
  PersistenceMode,
  PersistenceProvenance,
} from "@matchsense/db";

type JsonObject = Record<string, unknown>;

export interface MatchMemoryMoment {
  eventTeam: string | null;
  familyId: string;
  identity: string;
  kind: string;
  minute: string;
  player: { displayName: string | null; id: string } | null;
  revision: number;
  score: { away: number; home: number };
  status: string;
}

export interface MatchMemoryReplay {
  available: boolean;
  fixtureRoute: string;
  kind: "canonical_timeline" | "experience";
  momentRouteTemplate: string;
  restartable: boolean;
  runId: string | null;
  templateId: string | null;
  templateVersion: number | null;
}

export interface MatchMemoryPayload {
  awayTeam: string;
  decidedBy: string | null;
  finalizedAt: string;
  fixtureId: string;
  homeTeam: string;
  keyMoments: MatchMemoryMoment[];
  kickoffAt: string;
  mode: PersistenceMode;
  provenance: PersistenceProvenance;
  replay: MatchMemoryReplay;
  revision: number;
  schemaVersion: 1;
  score: { away: number; home: number };
  sourceLabel: string;
  stats: unknown;
  summary: string;
}

export interface MatchMemoryService {
  getForFan(input: {
    fanId: string;
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<MemoryRecord<MatchMemoryPayload> | null>;
  listForFan(
    fanId: string,
  ): Promise<readonly MemoryRecord<MatchMemoryPayload>[]>;
  projectForFan(input: {
    experienceRun?: ExperienceRunRecord | null;
    fanId: string;
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<MemoryRecord<MatchMemoryPayload> | null>;
  projectFixture(input: {
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<readonly MemoryRecord<MatchMemoryPayload>[]>;
}

export interface CreateMatchMemoryServiceOptions {
  experiences: {
    getRun?(runId: string): Promise<ExperienceRunRecord | null>;
    listForOwner(fanId: string): Promise<readonly ExperienceRunRecord[]>;
  };
  fans: {
    listFollows(fanId: string): Promise<readonly FanFollowRecord[]>;
    listFollowers?(input: {
      fixtureId: string;
      mode: PersistenceMode;
    }): Promise<readonly FanFollowRecord[]>;
  };
  fixtureTruth: {
    eventsAfter(input: {
      afterSequence: number;
      fixtureId: string;
      limit?: number;
      mode: PersistenceMode;
    }): Promise<readonly FixtureEventRecord[]>;
    get(input: {
      fixtureId: string;
      mode: PersistenceMode;
    }): Promise<FixtureRecord | null>;
    getLatestProjection(input: {
      fixtureId: string;
      mode: PersistenceMode;
    }): Promise<FixtureProjectionRecord | null>;
  };
  memories: Pick<
    MemoryRepository<MatchMemoryPayload>,
    "append" | "latestForFanFixture" | "listLatestForFan"
  >;
}

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function scoreValue(value: unknown) {
  const score = objectValue(value);
  const home = nonNegativeInteger(score?.home);
  const away = nonNegativeInteger(score?.away);
  return home === null || away === null ? null : { away, home };
}

function playerValue(value: unknown): MatchMemoryMoment["player"] {
  if (value === null || value === undefined) return null;
  const player = objectValue(value);
  if (!player || typeof player.id !== "string") return null;
  const displayName =
    player.displayName === null || typeof player.displayName === "string"
      ? player.displayName
      : null;
  return { displayName, id: player.id };
}

function momentFromEvent(event: FixtureEventRecord): MatchMemoryMoment | null {
  const payload = objectValue(event.payload);
  const moment = objectValue(payload?.moment);
  if (!moment) return null;
  const revision = nonNegativeInteger(moment.revision);
  const score = scoreValue(moment.score);
  if (
    typeof moment.identity !== "string" ||
    typeof moment.kind !== "string" ||
    typeof moment.minute !== "string" ||
    revision === null ||
    !score
  ) {
    return null;
  }
  const familyId =
    typeof moment.familyId === "string"
      ? moment.familyId
      : typeof moment.id === "string"
        ? moment.id
        : moment.identity.replace(/:\d+$/u, "");
  return {
    eventTeam:
      typeof moment.eventTeam === "string"
        ? moment.eventTeam
        : typeof moment.team === "string"
          ? moment.team
          : null,
    familyId,
    identity: moment.identity,
    kind: moment.kind,
    minute: moment.minute,
    player: playerValue(moment.player),
    revision,
    score,
    status: typeof moment.status === "string" ? moment.status : "confirmed",
  };
}

function projectionPayload(record: FixtureProjectionRecord) {
  const payload = objectValue(record.payload);
  if (!payload || payload.phase !== "full_time") return null;
  const score = scoreValue(payload.score);
  return score ? { payload, score } : null;
}

function sourceLabel(fixture: FixtureRecord) {
  switch (fixture.provenance) {
    case "live_txline":
      return "TXLINE · DEVNET SOURCE";
    case "recorded_txline_authorised":
      return "RECORDED · TXLINE DATA";
    case "synthetic_txline_shaped":
      return "SIMULATION · TXLINE-SHAPED DATA";
  }
}

function replayMetadata(
  fixture: FixtureRecord,
  moments: readonly MatchMemoryMoment[],
  run: ExperienceRunRecord | null,
): MatchMemoryReplay {
  const fixtureId = encodeURIComponent(fixture.id);
  return {
    available: moments.length > 0,
    fixtureRoute: `/matches/${fixtureId}/memory`,
    kind: run ? "experience" : "canonical_timeline",
    momentRouteTemplate: `/matches/${fixtureId}/moments/{identity}`,
    restartable: Boolean(run),
    runId: run?.id ?? null,
    templateId: run?.templateId ?? null,
    templateVersion: run?.templateVersion ?? null,
  };
}

function memoryKey(mode: PersistenceMode, fixtureId: string) {
  return `${mode}:${fixtureId}`;
}

export function createMatchMemoryService(
  options: CreateMatchMemoryServiceOptions,
): MatchMemoryService {
  const projectForFan: MatchMemoryService["projectForFan"] = async (input) => {
    const existing = await options.memories.latestForFanFixture(input);
    const [fixture, projection] = await Promise.all([
      options.fixtureTruth.get(input),
      options.fixtureTruth.getLatestProjection(input),
    ]);
    if (!fixture || !projection) return existing;
    const final = projectionPayload(projection);
    if (!final) return existing;
    if (existing && existing.revision >= projection.revision) return existing;
    const events = await options.fixtureTruth.eventsAfter({
      afterSequence: 0,
      fixtureId: input.fixtureId,
      limit: 1_000,
      mode: input.mode,
    });
    const keyMoments = events.flatMap((event) => {
      const moment = momentFromEvent(event);
      return moment ? [moment] : [];
    });
    const experienceRun = input.experienceRun ?? null;
    const payload: MatchMemoryPayload = {
      awayTeam: fixture.awayTeamId,
      decidedBy:
        typeof final.payload.decidedBy === "string"
          ? final.payload.decidedBy
          : null,
      finalizedAt: projection.updatedAt,
      fixtureId: fixture.id,
      homeTeam: fixture.homeTeamId,
      keyMoments,
      kickoffAt: fixture.scheduledAt,
      mode: fixture.mode,
      provenance: fixture.provenance,
      replay: replayMetadata(fixture, keyMoments, experienceRun),
      revision: projection.revision,
      schemaVersion: 1,
      score: final.score,
      sourceLabel: sourceLabel(fixture),
      stats: final.payload.stats ?? null,
      summary: `${fixture.homeTeamId} ${final.score.home}–${final.score.away} ${fixture.awayTeamId}`,
    };
    const appended = await options.memories.append({
      fanId: input.fanId,
      fixtureId: input.fixtureId,
      mode: input.mode,
      payload,
      revision: projection.revision,
    });
    return (
      appended ??
      (await options.memories.latestForFanFixture({
        fanId: input.fanId,
        fixtureId: input.fixtureId,
        mode: input.mode,
      }))
    );
  };

  const authorizedFixtures = async (fanId: string) => {
    const [follows, runs] = await Promise.all([
      options.fans.listFollows(fanId),
      options.experiences.listForOwner(fanId),
    ]);
    const fixtures = new Map<
      string,
      {
        experienceRun: ExperienceRunRecord | null;
        fixtureId: string;
        mode: PersistenceMode;
      }
    >();
    for (const follow of follows) {
      fixtures.set(memoryKey(follow.mode, follow.fixtureId), {
        experienceRun: null,
        fixtureId: follow.fixtureId,
        mode: follow.mode,
      });
    }
    for (const run of runs) {
      fixtures.set(memoryKey("demo", run.fixtureId), {
        experienceRun: run,
        fixtureId: run.fixtureId,
        mode: "demo",
      });
    }
    return fixtures;
  };

  return {
    getForFan: async (input) => {
      const existing = await options.memories.latestForFanFixture(input);
      const fixtures = await authorizedFixtures(input.fanId);
      const authorized = fixtures.get(memoryKey(input.mode, input.fixtureId));
      if (!authorized) return existing;
      return projectForFan({
        ...input,
        experienceRun: authorized.experienceRun,
      });
    },
    listForFan: async (fanId) => {
      const fixtures = await authorizedFixtures(fanId);
      await Promise.all(
        [...fixtures.values()].map((fixture) =>
          projectForFan({ ...fixture, fanId }),
        ),
      );
      return options.memories.listLatestForFan(fanId);
    },
    projectForFan,
    projectFixture: async (input) => {
      const [followers, run] = await Promise.all([
        options.fans.listFollowers?.(input) ?? [],
        input.mode === "demo" && input.fixtureId.startsWith("experience:")
          ? (options.experiences.getRun?.(
              input.fixtureId.slice("experience:".length),
            ) ?? null)
          : null,
      ]);
      const fanIds = new Set(followers.map(({ fanId }) => fanId));
      if (run?.ownerFanId) fanIds.add(run.ownerFanId);
      const projected = await Promise.all(
        [...fanIds].map((fanId) =>
          projectForFan({
            ...input,
            experienceRun: run,
            fanId,
          }),
        ),
      );
      return projected.filter(
        (memory): memory is MemoryRecord<MatchMemoryPayload> => memory !== null,
      );
    },
  };
}
