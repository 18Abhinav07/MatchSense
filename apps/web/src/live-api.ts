import type {
  CanonicalEventPayload,
  CatchupEventPayload,
  CommentaryEventPayload,
  FixtureArchiveStatus,
  FixtureFreshness,
  FixtureLifecycle,
  LiveCommentary,
  LiveMoment,
  LiveSnapshot,
  TeamCode,
} from "./product-state.js";

type JsonRecord = Record<string, unknown>;

export interface ProductTeam {
  code: TeamCode;
  name: string;
  primary: string;
  secondary: string;
  foreground?: string | undefined;
  flagUrl?: string | undefined;
}

export interface ProductCatalog {
  teams: ProductTeam[];
  sourceLabel?: string | undefined;
}

export interface ProductApi {
  fetchCatalog(signal?: AbortSignal): Promise<ProductCatalog>;
  fetchFixture(fixtureId: string, signal?: AbortSignal): Promise<LiveSnapshot>;
  fetchFixtures(signal?: AbortSignal): Promise<readonly LiveSnapshot[]>;
}

export interface MomentResolution {
  requested: LiveMoment | null;
  latest: LiveMoment | null;
  superseded: boolean;
  snapshot: LiveSnapshot;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function teamCode(value: unknown, fallback: string): TeamCode {
  if (typeof value === "string") return value.trim().toUpperCase() || fallback;
  const data = record(value);
  if (!data) return fallback;
  return text(data.code ?? data.shortCode ?? data.id, fallback).toUpperCase();
}

function teamName(value: unknown, fallback: string) {
  if (typeof value === "string") return fallback;
  const data = record(value);
  return data ? text(data.name ?? data.displayName, fallback) : fallback;
}

function normalizeScore(value: unknown) {
  const score = record(value);
  return {
    away: finiteNumber(score?.away ?? score?.awayGoals),
    home: finiteNumber(score?.home ?? score?.homeGoals),
  };
}

function normalizeLifecycle(value: unknown): FixtureLifecycle | undefined {
  const normalized = text(value).toUpperCase().replaceAll(" ", "_");
  const allowed: readonly FixtureLifecycle[] = [
    "SCHEDULED",
    "TRACKING",
    "LIVE",
    "TERMINAL_FACT_COMMITTED",
    "FINAL",
    "FINAL_REVISED",
    "RESULT_UNAVAILABLE",
  ];
  return allowed.includes(normalized as FixtureLifecycle)
    ? (normalized as FixtureLifecycle)
    : undefined;
}

function normalizeFreshness(value: unknown): FixtureFreshness | undefined {
  const normalized = text(value).toLowerCase();
  const allowed: readonly FixtureFreshness[] = [
    "live",
    "cached",
    "stale",
    "offline",
  ];
  return allowed.includes(normalized as FixtureFreshness)
    ? (normalized as FixtureFreshness)
    : undefined;
}

function normalizeArchiveStatus(
  value: unknown,
): FixtureArchiveStatus | undefined {
  const normalized = text(value).toUpperCase().replaceAll("-", "_");
  const allowed: readonly FixtureArchiveStatus[] = [
    "PENDING",
    "REPLAY_READY",
    "INVALID",
  ];
  return allowed.includes(normalized as FixtureArchiveStatus)
    ? (normalized as FixtureArchiveStatus)
    : undefined;
}

export function normalizeMoment(
  value: unknown,
  fixture: Pick<LiveSnapshot, "fixtureId" | "homeTeam" | "score">,
): LiveMoment | null {
  const item = record(value);
  if (!item) return null;
  const id = text(item.id ?? item.momentId);
  if (!id) return null;
  const revision = Math.max(0, finiteNumber(item.revision, 0));
  const identity = text(item.identity, `${id}:${revision}`);
  const eventTeam = teamCode(
    item.eventTeam ?? item.team ?? item.teamCode,
    fixture.homeTeam,
  );
  return {
    celebratesGoal: item.celebratesGoal === true,
    detail: text(item.detail) || undefined,
    eventTeam,
    id,
    identity,
    kind: text(item.kind ?? item.type, "event").toLowerCase(),
    minute: text(item.minute, "—"),
    playerName: text(item.playerName ?? item.playerDisplayName) || undefined,
    revision,
    score: normalizeScore(item.score ?? fixture.score),
    status: text(item.status, "confirmed").toLowerCase(),
    title: text(item.title ?? item.label) || undefined,
  };
}

export function normalizeFixture(value: unknown): LiveSnapshot | null {
  const item = record(value);
  if (!item) return null;
  const fixtureId = text(item.fixtureId ?? item.id);
  if (!fixtureId) return null;
  const homeValue = item.homeTeam ?? item.homeParticipant ?? item.participant1;
  const awayValue = item.awayTeam ?? item.awayParticipant ?? item.participant2;
  const homeTeam = teamCode(homeValue, "HOME");
  const awayTeam = teamCode(awayValue, "AWAY");
  const score = normalizeScore(item.score);
  const base: LiveSnapshot = {
    archiveStatus: normalizeArchiveStatus(
      item.archiveStatus ?? record(item.archive)?.status,
    ),
    awayTeam,
    awayTeamName: text(item.awayTeamName, teamName(awayValue, awayTeam)),
    competition: text(item.competition ?? item.competitionName) || undefined,
    fixtureId,
    freshness: normalizeFreshness(item.freshness ?? item.dataFreshness),
    homeTeam,
    homeTeamName: text(item.homeTeamName, teamName(homeValue, homeTeam)),
    kickoffAt: text(item.kickoffAt ?? item.startTime) || undefined,
    lifecycle: normalizeLifecycle(item.lifecycle),
    minute: text(item.minute ?? item.clock, "—"),
    phase: text(item.phase ?? item.status).toLowerCase() || undefined,
    provenance: text(item.provenance, "live_txline"),
    revision: Math.max(0, finiteNumber(item.revision, 0)),
    score,
    sourceLabel: text(item.sourceLabel, "TXLINE MATCH DATA"),
    updatedAt: text(item.updatedAt ?? item.observedAt) || undefined,
    venue: text(item.venue ?? item.venueName) || undefined,
  };
  base.lastEvent = normalizeMoment(item.lastEvent, base);
  return base;
}

export function normalizeCatalog(value: unknown): ProductCatalog {
  const root = record(value);
  const rawTeams = Array.isArray(root?.teams) ? root.teams : [];
  const teams = rawTeams.flatMap((entry): ProductTeam[] => {
    const item = record(entry);
    if (!item) return [];
    const code = teamCode(item, "");
    if (!code) return [];
    const colors = record(item.colors);
    return [
      {
        code,
        flagUrl: text(item.flagUrl ?? item.flag) || undefined,
        foreground: text(colors?.foreground ?? item.foreground) || undefined,
        name: text(item.name, code),
        primary: text(colors?.primary ?? item.primary, colorFor(code, 0)),
        secondary: text(colors?.secondary ?? item.secondary, colorFor(code, 1)),
      },
    ];
  });
  return { sourceLabel: text(root?.sourceLabel) || undefined, teams };
}

function colorFor(code: string, offset: number) {
  let hash = 0;
  for (const character of code)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const hue = Math.abs(hash + offset * 137) % 360;
  return `hsl(${hue} 58% ${offset === 0 ? 48 : 72}%)`;
}

export function fallbackTeam(code: TeamCode, name?: string): ProductTeam {
  return {
    code,
    foreground: "#f7f4ea",
    name: name || code,
    primary: colorFor(code, 0),
    secondary: colorFor(code, 1),
  };
}

async function fetchJson(
  url: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<unknown>;
}

export function createProductApi(
  options: { fetcher?: typeof fetch | undefined } = {},
): ProductApi {
  const fetcher = options.fetcher ?? fetch;
  return {
    fetchCatalog: async (signal) =>
      normalizeCatalog(await fetchJson("/api/v1/catalog", fetcher, signal)),
    fetchFixture: async (fixtureId, signal) => {
      const fixture = normalizeFixture(
        await fetchJson(
          `/api/v1/fixtures/${encodeURIComponent(fixtureId)}`,
          fetcher,
          signal,
        ),
      );
      if (!fixture) throw new Error("Fixture data was invalid");
      return fixture;
    },
    fetchFixtures: async (signal) => {
      const payload = await fetchJson("/api/v1/fixtures", fetcher, signal);
      const root = record(payload);
      const source = Array.isArray(payload)
        ? payload
        : Array.isArray(root?.fixtures)
          ? root.fixtures
          : [];
      return source.flatMap((value) => {
        const fixture = normalizeFixture(value);
        return fixture ? [fixture] : [];
      });
    },
  };
}

export async function fetchCatalog(signal?: AbortSignal) {
  return createProductApi().fetchCatalog(signal);
}

export async function fetchFixtures(signal?: AbortSignal) {
  return createProductApi().fetchFixtures(signal);
}

export async function fetchFixture(fixtureId: string, signal?: AbortSignal) {
  return createProductApi().fetchFixture(fixtureId, signal);
}

export async function fetchMomentResolution(
  fixtureId: string,
  momentIdentity: string,
  signal?: AbortSignal,
): Promise<MomentResolution> {
  const payload = record(
    await fetchJson(
      `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/moments/${encodeURIComponent(momentIdentity)}`,
      fetch,
      signal,
    ),
  );
  const snapshot = normalizeFixture(payload?.snapshot);
  if (!payload || !snapshot) throw new Error("Moment resolution was invalid");
  const requested =
    payload.requested === null
      ? null
      : normalizeMoment(payload.requested, snapshot);
  const latest =
    payload.latest === null ? null : normalizeMoment(payload.latest, snapshot);
  if (
    (payload.requested !== null && !requested) ||
    (payload.latest !== null && !latest)
  ) {
    throw new Error("Moment resolution was invalid");
  }
  return {
    latest,
    requested,
    snapshot,
    superseded: payload.superseded === true,
  };
}

export function parseSnapshotEvent(value: string) {
  const payload = record(JSON.parse(value));
  const snapshot = normalizeFixture(payload?.snapshot ?? payload);
  return snapshot;
}

export function parseCanonicalEvent(
  value: string,
): CanonicalEventPayload | null {
  const payload = record(JSON.parse(value));
  const snapshot = normalizeFixture(payload?.snapshot);
  if (!payload || !snapshot) return null;
  const moment = normalizeMoment(payload.moment, snapshot);
  if (!moment) return null;
  const event = text(payload.event, "moment.created");
  if (event !== "moment.created" && event !== "moment.revised") return null;
  return {
    event,
    id: text(payload.id, moment.identity),
    moment,
    snapshot,
  };
}

export function parseCommentaryEvent(
  value: string,
): CommentaryEventPayload | null {
  const payload = record(JSON.parse(value));
  const snapshot = normalizeFixture(payload?.snapshot);
  const raw = record(payload?.commentary);
  if (!payload || !snapshot || !raw) return null;
  const momentIdentity = text(raw.momentIdentity);
  if (!momentIdentity) return null;
  const commentary: LiveCommentary = {
    generatedAt: text(raw.generatedAt, new Date().toISOString()),
    language: "en",
    momentIdentity,
    provider: raw.provider === "gemini" ? "gemini" : "deterministic",
    text: text(raw.text, "Commentary unavailable."),
    usedFallback: Boolean(raw.usedFallback),
  };
  return {
    commentary,
    event: "commentary.ready",
    id: text(payload.id, `commentary:${momentIdentity}`),
    snapshot,
  };
}

export function parseCatchupEvent(value: string): CatchupEventPayload | null {
  const payload = record(JSON.parse(value));
  const snapshot = normalizeFixture(payload?.snapshot);
  const raw = record(payload?.catchup);
  if (!payload || !snapshot || !raw || !Array.isArray(raw.moments)) return null;
  const moments = raw.moments.flatMap((item) => {
    const moment = normalizeMoment(item, snapshot);
    return moment ? [moment] : [];
  });
  return {
    catchup: {
      fromEventId: text(raw.fromEventId, "unknown"),
      moments,
    },
    event: "catchup.ready",
    id: text(payload.id, `catchup:${snapshot.fixtureId}:${snapshot.revision}`),
    snapshot,
  };
}

export function fixtureState(snapshot: LiveSnapshot, _now = Date.now()) {
  void _now;
  if (
    snapshot.lifecycle === "FINAL" ||
    snapshot.lifecycle === "FINAL_REVISED" ||
    snapshot.lifecycle === "TERMINAL_FACT_COMMITTED"
  ) {
    return "final";
  }
  if (snapshot.lifecycle === "LIVE") return "live";
  const phase = (snapshot.phase ?? "").toLowerCase();
  if (/final|finished|full_time|game_finalised/u.test(phase)) return "final";
  if (
    /live|half|extra|penalt|break/u.test(phase) &&
    !/scheduled/u.test(phase)
  ) {
    return "live";
  }
  return "upcoming";
}

export type TodayFixtureBucket = "live" | "upcoming" | "verified_final";

export function todayFixtureBucket(
  snapshot: LiveSnapshot,
): TodayFixtureBucket | null {
  if (
    snapshot.lifecycle === "RESULT_UNAVAILABLE" ||
    snapshot.lifecycle === "TERMINAL_FACT_COMMITTED"
  ) {
    return null;
  }
  if (
    (snapshot.lifecycle === "FINAL" ||
      snapshot.lifecycle === "FINAL_REVISED") &&
    snapshot.archiveStatus === "REPLAY_READY"
  ) {
    return "verified_final";
  }
  if (snapshot.lifecycle === "LIVE" && snapshot.freshness === "live") {
    return "live";
  }
  if (snapshot.lifecycle === "SCHEDULED" || snapshot.lifecycle === "TRACKING") {
    return "upcoming";
  }
  return null;
}

export function eventLabel(moment: LiveMoment) {
  const labels: Record<string, string> = {
    corner: "Corner",
    full_time: "Full time",
    goal: "Goal",
    half_time: "Half time",
    penalty: "Penalty",
    red_card: "Red card",
    substitution: "Substitution",
    var: "VAR review",
    "var.overturned": "VAR overturned",
    "var.stands": "VAR stands",
    var_overturned: "VAR overturned",
    var_stands: "VAR stands",
    yellow_card: "Yellow card",
  };
  return (
    moment.title || labels[moment.kind] || moment.kind.replaceAll("_", " ")
  );
}
