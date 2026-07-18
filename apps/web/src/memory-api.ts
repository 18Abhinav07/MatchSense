import {
  normalizeFixture,
  normalizeMoment,
  type ProductApi,
} from "./live-api.js";
import type { LiveMoment, LiveSnapshot } from "./product-state.js";

type JsonObject = Record<string, unknown>;

export interface VerifiedMemoryTimelineEvent {
  createdAt: string;
  eventId: string;
  eventType: string;
  moment: LiveMoment | null;
  sequence: number;
}

export interface VerifiedFixtureMemory {
  archiveManifestId: string;
  fixture: LiveSnapshot & {
    archiveManifestId: string;
    archiveStatus: "REPLAY_READY";
    score: { away: number; home: number };
  };
  timeline: readonly VerifiedMemoryTimelineEvent[];
}

export interface MemoryApi {
  fetchFixtureMemory(
    fixtureId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedFixtureMemory>;
  fetchHistory(signal?: AbortSignal): Promise<readonly LiveSnapshot[]>;
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function canonicalPayload(value: unknown): JsonObject | null {
  const payload = record(value);
  if (!payload) return null;
  const nested = record(payload.event);
  return nested?.payload && record(nested.payload)
    ? (record(nested.payload) as JsonObject)
    : payload;
}

function normalizeTimelineEvent(
  value: unknown,
  fixture: LiveSnapshot,
): VerifiedMemoryTimelineEvent | null {
  const data = record(value);
  const createdAt = text(data?.createdAt);
  const eventId = text(data?.eventId);
  const eventType = text(data?.eventType);
  const sequence = integer(data?.sequence);
  const payload = canonicalPayload(data?.payload);
  if (
    !data ||
    !createdAt ||
    !eventId ||
    !eventType ||
    sequence === null ||
    !payload
  ) {
    return null;
  }
  const nestedEvent = record(payload.event);
  const rawMoment = payload.moment ?? nestedEvent?.moment;
  return {
    createdAt,
    eventId,
    eventType,
    moment:
      rawMoment === undefined ? null : normalizeMoment(rawMoment, fixture),
    sequence,
  };
}

export function normalizeVerifiedFixtureMemory(
  value: unknown,
): VerifiedFixtureMemory | null {
  const root = record(value);
  const memory = record(root?.memory);
  const fixture = normalizeFixture(memory?.fixture);
  if (
    !memory ||
    !fixture ||
    !fixture.archiveManifestId ||
    fixture.archiveStatus !== "REPLAY_READY" ||
    (fixture.lifecycle !== "FINAL" && fixture.lifecycle !== "FINAL_REVISED") ||
    fixture.mode !== "recorded" ||
    fixture.provenance !== "recorded_txline_authorised" ||
    !fixture.score ||
    !Array.isArray(memory.timeline)
  ) {
    return null;
  }
  const timeline = memory.timeline.map((event) =>
    normalizeTimelineEvent(event, fixture),
  );
  if (timeline.some((event) => event === null)) return null;
  return {
    archiveManifestId: fixture.archiveManifestId,
    fixture: {
      ...fixture,
      archiveManifestId: fixture.archiveManifestId,
      archiveStatus: "REPLAY_READY",
      score: fixture.score,
    },
    timeline: timeline as VerifiedMemoryTimelineEvent[],
  };
}

async function getJson(
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

export function createMemoryApi(
  options: { fetcher?: typeof fetch | undefined } = {},
): MemoryApi {
  const fetcher = options.fetcher ?? fetch;
  return {
    fetchFixtureMemory: async (fixtureId, signal) => {
      const memory = normalizeVerifiedFixtureMemory(
        await getJson(
          `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/memory`,
          fetcher,
          signal,
        ),
      );
      if (!memory) throw new Error("Verified Match Memory data was invalid");
      return memory;
    },
    fetchHistory: async (signal) => {
      const root = record(await getJson("/api/v1/history", fetcher, signal));
      if (!Array.isArray(root?.fixtures)) {
        throw new Error("Verified history data was invalid");
      }
      return root.fixtures.flatMap((entry) => {
        const fixture = normalizeFixture(entry);
        return fixture?.archiveStatus === "REPLAY_READY" &&
          (fixture.lifecycle === "FINAL" ||
            fixture.lifecycle === "FINAL_REVISED") &&
          fixture.mode === "recorded" &&
          fixture.provenance === "recorded_txline_authorised"
          ? [fixture]
          : [];
      });
    },
  };
}

export async function fetchVerifiedFixtureMemory(
  fixtureId: string,
  signal?: AbortSignal,
) {
  return createMemoryApi().fetchFixtureMemory(fixtureId, signal);
}

export async function fetchVerifiedHistory(signal?: AbortSignal) {
  return createMemoryApi().fetchHistory(signal);
}

/** Kept as a typed seam for surfaces that already inject the fixture client. */
export type FixtureMemoryProductApi = Pick<
  ProductApi,
  "fetchFixture" | "fetchFixtures"
>;
