type JsonObject = Record<string, unknown>;

export interface MatchMemoryMomentRecord {
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

export interface MatchMemoryReplayRecord {
  available: boolean;
  fixtureRoute: string;
  kind: "canonical_timeline" | "experience";
  momentRouteTemplate: string;
  restartable: boolean;
  runId: string | null;
  templateId: string | null;
  templateVersion: number | null;
}

export interface MatchMemoryRecord {
  createdAt: string;
  fanId: string;
  fixtureId: string;
  mode: "demo" | "live";
  payload: {
    awayTeam: string;
    decidedBy: string | null;
    finalizedAt: string;
    fixtureId: string;
    homeTeam: string;
    keyMoments: MatchMemoryMomentRecord[];
    kickoffAt: string;
    mode: "demo" | "live";
    provenance: "live_txline" | "synthetic_txline_shaped";
    replay: MatchMemoryReplayRecord;
    revision: number;
    schemaVersion: 1;
    score: { away: number; home: number };
    sourceLabel: string;
    stats: unknown;
    summary: string;
  };
  revision: number;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown) {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function score(value: unknown) {
  const data = object(value);
  const home = integer(data?.home);
  const away = integer(data?.away);
  return home === null || away === null ? null : { away, home };
}

function player(value: unknown): MatchMemoryMomentRecord["player"] | undefined {
  if (value === null) return null;
  const data = object(value);
  const id = string(data?.id);
  const displayName = nullableString(data?.displayName);
  if (!data || !id || displayName === undefined) return undefined;
  return { displayName, id };
}

function moment(value: unknown): MatchMemoryMomentRecord | null {
  const data = object(value);
  const eventTeam = nullableString(data?.eventTeam);
  const familyId = string(data?.familyId);
  const identity = string(data?.identity);
  const kind = string(data?.kind);
  const minute = string(data?.minute);
  const parsedPlayer = player(data?.player);
  const revision = integer(data?.revision);
  const parsedScore = score(data?.score);
  const status = string(data?.status);
  if (
    !data ||
    eventTeam === undefined ||
    !familyId ||
    !identity ||
    !kind ||
    !minute ||
    parsedPlayer === undefined ||
    revision === null ||
    !parsedScore ||
    !status
  ) {
    return null;
  }
  return {
    eventTeam,
    familyId,
    identity,
    kind,
    minute,
    player: parsedPlayer,
    revision,
    score: parsedScore,
    status,
  };
}

function replay(value: unknown): MatchMemoryReplayRecord | null {
  const data = object(value);
  const fixtureRoute = string(data?.fixtureRoute);
  const kind = data?.kind;
  const momentRouteTemplate = string(data?.momentRouteTemplate);
  const runId = nullableString(data?.runId);
  const templateId = nullableString(data?.templateId);
  const templateVersion =
    data?.templateVersion === null
      ? null
      : (integer(data?.templateVersion) ?? undefined);
  if (
    !data ||
    typeof data.available !== "boolean" ||
    !fixtureRoute ||
    (kind !== "canonical_timeline" && kind !== "experience") ||
    !momentRouteTemplate ||
    typeof data.restartable !== "boolean" ||
    runId === undefined ||
    templateId === undefined ||
    templateVersion === undefined
  ) {
    return null;
  }
  return {
    available: data.available,
    fixtureRoute,
    kind,
    momentRouteTemplate,
    restartable: data.restartable,
    runId,
    templateId,
    templateVersion,
  };
}

export function normalizeMatchMemory(value: unknown): MatchMemoryRecord | null {
  const data = object(value);
  const payload = object(data?.payload);
  const createdAt = string(data?.createdAt);
  const fanId = string(data?.fanId);
  const fixtureId = string(data?.fixtureId);
  const mode = data?.mode;
  const revision = integer(data?.revision);
  const awayTeam = string(payload?.awayTeam);
  const decidedBy = nullableString(payload?.decidedBy);
  const finalizedAt = string(payload?.finalizedAt);
  const payloadFixtureId = string(payload?.fixtureId);
  const homeTeam = string(payload?.homeTeam);
  const kickoffAt = string(payload?.kickoffAt);
  const payloadMode = payload?.mode;
  const provenance = payload?.provenance;
  const parsedReplay = replay(payload?.replay);
  const payloadRevision = integer(payload?.revision);
  const parsedScore = score(payload?.score);
  const sourceLabel = string(payload?.sourceLabel);
  const summary = string(payload?.summary);
  const rawMoments = payload?.keyMoments;
  const keyMoments = Array.isArray(rawMoments) ? rawMoments.map(moment) : null;
  if (
    !data ||
    !payload ||
    !createdAt ||
    !fanId ||
    !fixtureId ||
    (mode !== "demo" && mode !== "live") ||
    revision === null ||
    !awayTeam ||
    decidedBy === undefined ||
    !finalizedAt ||
    payloadFixtureId !== fixtureId ||
    !homeTeam ||
    !keyMoments ||
    keyMoments.some((item) => item === null) ||
    !kickoffAt ||
    payloadMode !== mode ||
    (provenance !== "live_txline" &&
      provenance !== "synthetic_txline_shaped") ||
    !parsedReplay ||
    payloadRevision !== revision ||
    payload?.schemaVersion !== 1 ||
    !parsedScore ||
    !sourceLabel ||
    !summary
  ) {
    return null;
  }
  return {
    createdAt,
    fanId,
    fixtureId,
    mode,
    payload: {
      awayTeam,
      decidedBy,
      finalizedAt,
      fixtureId: payloadFixtureId,
      homeTeam,
      keyMoments: keyMoments as MatchMemoryMomentRecord[],
      kickoffAt,
      mode,
      provenance,
      replay: parsedReplay,
      revision: payloadRevision,
      schemaVersion: 1,
      score: parsedScore,
      sourceLabel,
      stats: payload.stats ?? null,
      summary,
    },
    revision,
  };
}

async function getJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<unknown>;
}

function invalid(): never {
  throw new Error("Match Memory data was invalid");
}

export async function fetchMatchMemories(signal?: AbortSignal) {
  const root = object(await getJson("/api/v1/memories", signal));
  if (!Array.isArray(root?.memories)) return invalid();
  const memories = root.memories.map(normalizeMatchMemory);
  if (memories.some((item) => item === null)) return invalid();
  return memories as MatchMemoryRecord[];
}

export async function fetchMatchMemory(
  fixtureId: string,
  signal?: AbortSignal,
) {
  const root = object(
    await getJson(`/api/v1/memories/${encodeURIComponent(fixtureId)}`, signal),
  );
  const memory = normalizeMatchMemory(root?.memory);
  return memory ?? invalid();
}
