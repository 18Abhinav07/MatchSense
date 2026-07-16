import type {
  ReplayCommand,
  SyntheticSourceEnvelope,
} from "@matchsense/contracts";

export const DEMO_FIXTURE_ID = "arg-fra-demo";

export interface ReplaySession {
  id: string;
  fixtureId: string;
  emittedMarkers: Set<ReplayCommand["marker"]>;
}

export function createReplaySession(
  id: string,
  fixtureId: string,
): ReplaySession {
  if (fixtureId !== DEMO_FIXTURE_ID) {
    throw new Error("Replay fixture is not available");
  }
  return { emittedMarkers: new Set(), fixtureId, id };
}

export function advanceReplay(
  session: ReplaySession,
  command: ReplayCommand,
  receivedAt: string,
): SyntheticSourceEnvelope | null {
  if (session.emittedMarkers.has(command.marker)) {
    return null;
  }
  session.emittedMarkers.add(command.marker);

  return {
    fixtureId: session.fixtureId,
    id: "synthetic-goal-arg-fra-1",
    provenance: "synthetic_txline_shaped",
    receivedAt,
    source: "replay",
    supportedFact: {
      awayGoals: 0,
      homeGoals: 1,
      minute: "23'",
      type: "score_snapshot",
    },
  };
}
