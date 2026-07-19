import type { LiveMoment, LiveSnapshot } from "../../product-state.js";

export interface ExperienceRun {
  completedAt: string | null;
  fixtureId: string;
  id: string;
  kickoffAt: string;
  nextBeatIndex: number;
  status: "ready" | "countdown" | "live" | "final" | "cancelled";
  templateVersion: number;
}

export interface ExperienceMomentResolution {
  latest: LiveMoment | null;
  requested: LiveMoment | null;
  snapshot: LiveSnapshot;
  superseded: boolean;
}

export interface ExperienceTimeline {
  cursor: string | null;
  events: readonly ExperienceStreamEvent[];
  fixture: LiveSnapshot;
}

export type ExperienceStreamEvent =
  | { event: "snapshot"; id: string; snapshot: LiveSnapshot }
  | {
      event: "moment.created" | "moment.revised";
      id: string;
      moment: LiveMoment;
      snapshot: LiveSnapshot;
    }
  | {
      commentary: {
        generatedAt: string;
        momentIdentity: string;
        text: string;
      };
      event: "commentary.ready";
      id: string;
      snapshot: LiveSnapshot;
    }
  | {
      catchup: { fromEventId: string; moments: LiveMoment[] };
      event: "catchup.ready";
      id: string;
      snapshot: LiveSnapshot;
    };

function csrfHeaders() {
  if (typeof document === "undefined") return {};
  const entry = document.cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("matchsense_csrf="));
  const token = entry?.slice("matchsense_csrf=".length);
  return token ? { "x-matchsense-csrf": decodeURIComponent(token) } : {};
}

async function readJson<T>(response: Response, message: string): Promise<T> {
  if (!response.ok) throw new Error(message);
  return (await response.json()) as T;
}

export interface ExperienceApi {
  fetchFixture(runId: string, signal?: AbortSignal): Promise<LiveSnapshot>;
  fetchMoment(
    runId: string,
    identity: string,
    signal?: AbortSignal,
  ): Promise<ExperienceMomentResolution>;
  fetchRun(runId: string, signal?: AbortSignal): Promise<ExperienceRun>;
  fetchTimeline(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ExperienceTimeline>;
  start(input: { awayTeam: string; homeTeam: string }): Promise<ExperienceRun>;
  stream(
    runId: string,
    onEvent: (event: ExperienceStreamEvent) => void,
    afterEventId?: string | null,
  ): {
    close(): void;
  };
}

export function createExperienceApi(
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): ExperienceApi {
  return {
    async fetchFixture(runId, signal) {
      return readJson<LiveSnapshot>(
        await fetcher(
          `/api/v1/experience/runs/${encodeURIComponent(runId)}/fixture`,
          signal ? { signal } : {},
        ),
        "Experience match truth is unavailable",
      );
    },
    async fetchMoment(runId, identity, signal) {
      return readJson<ExperienceMomentResolution>(
        await fetcher(
          `/api/v1/experience/runs/${encodeURIComponent(runId)}/moments/${encodeURIComponent(identity)}`,
          signal ? { signal } : {},
        ),
        "This Experience Moment is unavailable",
      );
    },
    async fetchRun(runId, signal) {
      const result = await readJson<{ run: ExperienceRun }>(
        await fetcher(
          `/api/v1/experience/runs/${encodeURIComponent(runId)}`,
          signal ? { signal } : {},
        ),
        "Experience run is unavailable",
      );
      return result.run;
    },
    async fetchTimeline(runId, signal) {
      return readJson<ExperienceTimeline>(
        await fetcher(
          `/api/v1/experience/runs/${encodeURIComponent(runId)}/timeline`,
          signal ? { signal } : {},
        ),
        "Experience match history is unavailable",
      );
    },
    async start(input) {
      const result = await readJson<{ run: ExperienceRun }>(
        await fetcher("/api/v1/experience/runs", {
          body: JSON.stringify(input),
          headers: {
            "content-type": "application/json",
            ...csrfHeaders(),
            "idempotency-key": `experience-${crypto.randomUUID()}`,
          },
          method: "POST",
        }),
        "Experience match could not be started",
      );
      return result.run;
    },
    stream(runId, onEvent, afterEventId) {
      const after = afterEventId
        ? `?after=${encodeURIComponent(afterEventId)}`
        : "";
      const source = new EventSource(
        `/api/v1/experience/runs/${encodeURIComponent(runId)}/stream${after}`,
        { withCredentials: true },
      );
      for (const eventName of [
        "snapshot",
        "moment.created",
        "moment.revised",
        "commentary.ready",
        "catchup.ready",
      ]) {
        source.addEventListener(eventName, (event) => {
          try {
            onEvent(JSON.parse(event.data) as ExperienceStreamEvent);
          } catch {
            // A malformed event is ignored; the next snapshot is authoritative.
          }
        });
      }
      return { close: () => source.close() };
    },
  };
}
