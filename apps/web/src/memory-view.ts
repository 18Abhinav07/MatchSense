import type { VerifiedFixtureMemory } from "./memory-api.js";
import type { LiveMoment } from "./product-state.js";

export interface VerifiedMemoryView {
  archiveManifestId: string;
  fixture: VerifiedFixtureMemory["fixture"];
  moments: readonly LiveMoment[];
  summary: string;
}

/**
 * A deliberately small view model: all content remains traceable to the
 * archive-qualified fixture or its canonical timeline. No inferred stats,
 * locally-written summary, or browser-created history may enter this shape.
 */
export function verifiedMemoryView(
  memory: VerifiedFixtureMemory,
): VerifiedMemoryView {
  const { fixture } = memory;
  return {
    archiveManifestId: memory.archiveManifestId,
    fixture,
    moments: memory.timeline.flatMap((event) =>
      event.moment ? [event.moment] : [],
    ),
    summary: `${fixture.homeTeam} ${fixture.score.home}—${fixture.score.away} ${fixture.awayTeam} · final archive verified`,
  };
}
