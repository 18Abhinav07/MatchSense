import { TeamFlag } from "../../components/TeamFlag.js";
import { MemorySourceNotice } from "../../MemorySourceNotice.js";
import {
  eventLabel,
  fallbackTeam,
  type ProductCatalog,
  type ProductTeam,
} from "../../live-api.js";
import type { VerifiedFixtureMemory } from "../../memory-api.js";

import "./memory-surface.css";

export interface MemorySurfaceProps {
  catalog: ProductCatalog;
  memory: VerifiedFixtureMemory;
  onBack?: (() => void) | undefined;
  onOpenReplay?: ((fixtureId: string) => void) | undefined;
}

function teamFor(catalog: ProductCatalog, code: string): ProductTeam {
  return catalog.teams.find((team) => team.code === code) ?? fallbackTeam(code);
}

function archiveVerified(memory: VerifiedFixtureMemory) {
  const fixture = memory.fixture;
  return (
    fixture.archiveStatus === "REPLAY_READY" &&
    Boolean(fixture.archiveManifestId) &&
    fixture.mode === "recorded" &&
    fixture.provenance === "recorded_txline_authorised" &&
    (fixture.lifecycle === "FINAL" || fixture.lifecycle === "FINAL_REVISED") &&
    fixture.score !== null
  );
}

export function MemorySurface({
  catalog,
  memory,
  onBack,
  onOpenReplay,
}: MemorySurfaceProps) {
  if (!archiveVerified(memory)) {
    return (
      <main
        className="ms-memory-surface ms-memory-surface--unavailable"
        id="main-content"
      >
        {onBack ? (
          <button onClick={onBack} type="button">
            Back to match day
          </button>
        ) : null}
        <MemorySourceNotice source="unavailable" />
      </main>
    );
  }

  const fixture = memory.fixture;
  const score = fixture.score;
  const home = teamFor(catalog, fixture.homeTeam);
  const away = teamFor(catalog, fixture.awayTeam);
  const canonicalMoments = memory.timeline.flatMap((event) =>
    event.moment ? [{ event, moment: event.moment }] : [],
  );

  return (
    <main className="ms-memory-surface" id="main-content">
      <header className="ms-memory-surface__header">
        {onBack ? (
          <button onClick={onBack} type="button">
            Match day
          </button>
        ) : (
          <span>MatchSense</span>
        )}
        <span>FINAL RECORD</span>
      </header>

      <section
        className="ms-memory-surface__result"
        aria-label="Verified final result"
      >
        <MemorySourceNotice source="archive-verified" />
        <div className="ms-memory-surface__scoreline">
          <div>
            <TeamFlag size="hero" team={home} />
            <span>{home.name}</span>
          </div>
          <strong>
            <span>{score.home}</span>
            <i>—</i>
            <span>{score.away}</span>
            <small>Full time</small>
          </strong>
          <div>
            <TeamFlag size="hero" team={away} />
            <span>{away.name}</span>
          </div>
        </div>
        <p>
          {home.name} {score.home}—{score.away} {away.name}
        </p>
      </section>

      <section
        className="ms-memory-surface__record"
        aria-labelledby="memory-record-title"
      >
        <header>
          <div>
            <p>CANONICAL MATCH RECORD</p>
            <h1 id="memory-record-title">How the final was written</h1>
          </div>
          <span>{fixture.sourceLabel ?? "TXLINE MATCH DATA"}</span>
        </header>
        {canonicalMoments.length ? (
          <ol>
            {canonicalMoments.map(({ event, moment }) => (
              <li key={`${event.sequence}:${event.eventId}`}>
                <time>{moment.minute}</time>
                <div>
                  <strong>{eventLabel(moment)}</strong>
                  <span>{moment.detail ?? "Canonical match event"}</span>
                </div>
                <small>REV {moment.revision}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ms-memory-surface__empty">
            This verified final has no published canonical Moments in its
            archive.
          </p>
        )}
      </section>

      <footer className="ms-memory-surface__footer">
        <span>ARCHIVE {memory.archiveManifestId}</span>
        {onOpenReplay ? (
          <button onClick={() => onOpenReplay(fixture.fixtureId)} type="button">
            Open recorded replay
          </button>
        ) : null}
      </footer>
    </main>
  );
}
