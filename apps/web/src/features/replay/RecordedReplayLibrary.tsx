import { TeamFlag } from "../../components/TeamFlag.js";
import {
  fallbackTeam,
  type ProductCatalog,
  type ProductTeam,
} from "../../live-api.js";
import type { LiveSnapshot } from "../../product-state.js";

import "./recorded-replay.css";

export type RecordedReplayLibraryState = "loading" | "ready" | "unavailable";

export interface RecordedReplayLibraryProps {
  catalog: ProductCatalog;
  fixtures: readonly LiveSnapshot[];
  onBack?: (() => void) | undefined;
  onOpenMemory?: ((fixtureId: string) => void) | undefined;
  onOpenReplay?: ((fixtureId: string) => void) | undefined;
  state: RecordedReplayLibraryState;
}

function teamFor(catalog: ProductCatalog, code: string): ProductTeam {
  return catalog.teams.find((team) => team.code === code) ?? fallbackTeam(code);
}

function eligible(fixture: LiveSnapshot) {
  return (
    fixture.archiveStatus === "REPLAY_READY" &&
    Boolean(fixture.archiveManifestId) &&
    fixture.mode === "recorded" &&
    fixture.provenance === "recorded_txline_authorised" &&
    (fixture.lifecycle === "FINAL" || fixture.lifecycle === "FINAL_REVISED") &&
    fixture.score !== null
  );
}

export function RecordedReplayLibrary({
  catalog,
  fixtures,
  onBack,
  onOpenMemory,
  onOpenReplay,
  state,
}: RecordedReplayLibraryProps) {
  if (state === "loading") {
    return (
      <main
        className="ms-recorded-library ms-recorded-library--state"
        id="main-content"
      >
        <p>Opening recorded replay archive…</p>
      </main>
    );
  }
  if (state === "unavailable") {
    return (
      <main
        className="ms-recorded-library ms-recorded-library--state"
        id="main-content"
      >
        {onBack ? (
          <button onClick={onBack} type="button">
            Back to match day
          </button>
        ) : null}
        <p>Recorded replay archive unavailable</p>
        <span>
          MatchSense will not substitute a demo or locally created replay.
        </span>
      </main>
    );
  }

  const records = fixtures.filter(eligible);

  return (
    <main className="ms-recorded-library" id="main-content">
      <header className="ms-recorded-library__header">
        {onBack ? (
          <button onClick={onBack} type="button">
            Match day
          </button>
        ) : (
          <span>MatchSense</span>
        )}
        <span>TXLINE ARCHIVE</span>
      </header>
      <section className="ms-recorded-library__intro">
        <p>VERIFIED HISTORY</p>
        <h1>RECORDED REPLAYS</h1>
        <span>
          Open a finished match only when its authorised archive and final
          result are ready.
        </span>
      </section>
      {records.length ? (
        <ol className="ms-recorded-library__list">
          {records.map((fixture) => {
            const home = teamFor(catalog, fixture.homeTeam);
            const away = teamFor(catalog, fixture.awayTeam);
            const score = fixture.score;
            if (!score) return null;
            return (
              <li key={fixture.fixtureId}>
                <div className="ms-recorded-library__teams">
                  <TeamFlag size="standard" team={home} />
                  <div>
                    <strong>
                      {home.name} {score.home}—{score.away} {away.name}
                    </strong>
                    <span>FINAL · ARCHIVE VERIFIED</span>
                  </div>
                  <TeamFlag size="standard" team={away} />
                </div>
                {onOpenReplay || onOpenMemory ? (
                  <div className="ms-recorded-library__actions">
                    {onOpenMemory ? (
                      <button
                        onClick={() => onOpenMemory(fixture.fixtureId)}
                        type="button"
                      >
                        View verified Memory
                      </button>
                    ) : null}
                    {onOpenReplay ? (
                      <button
                        onClick={() => onOpenReplay(fixture.fixtureId)}
                        type="button"
                      >
                        Open recorded replay
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <section className="ms-recorded-library__empty" role="status">
          <h2>No recorded replays are available yet</h2>
          <p>
            A match appears here only after its authorised archive reaches a
            verified final state.
          </p>
        </section>
      )}
    </main>
  );
}
