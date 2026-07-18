import { TeamFlag } from "../../components/TeamFlag.js";
import {
  eventLabel,
  type ProductCatalog,
  type ProductTeam,
} from "../../live-api.js";
import { formatFreshness, type LiveSnapshot } from "../../product-state.js";

import "./match-hub.css";

export type MatchHubState = "loading" | "ready" | "unavailable";

export interface MatchHubProps {
  catalog: ProductCatalog;
  favoriteTeam: string | null;
  fixture: LiveSnapshot | null;
  onBack?: (() => void) | undefined;
  onOpenMoment?: ((identity: string) => void) | undefined;
  state: MatchHubState;
}

function teamFor(
  catalog: ProductCatalog,
  code: string,
  name: string | undefined,
): ProductTeam {
  return (
    catalog.teams.find((team) => team.code === code) ?? {
      code,
      name: name || code,
      primary: "#2d4638",
      secondary: "#e6ece1",
    }
  );
}

function freshnessLabel(fixture: LiveSnapshot) {
  if (fixture.lifecycle === "LIVE" && fixture.freshness === "live") {
    return "LIVE";
  }
  if (fixture.freshness === "cached") return "CACHED DATA";
  if (fixture.freshness === "stale") return "STALE DATA";
  if (fixture.freshness === "offline") return "OFFLINE";
  if (fixture.lifecycle === "FINAL" || fixture.lifecycle === "FINAL_REVISED") {
    return fixture.archiveStatus === "REPLAY_READY"
      ? "VERIFIED FINAL"
      : "FINAL AWAITING ARCHIVE";
  }
  return "MATCH STATUS PENDING";
}

export function MatchHub({
  catalog,
  favoriteTeam,
  fixture,
  onBack,
  onOpenMoment,
  state,
}: MatchHubProps) {
  if (state === "loading") {
    return (
      <main className="ms-match-hub ms-match-hub--loading" id="main-content">
        <p>Loading match truth</p>
        <span>
          The score will appear only after the server returns this fixture.
        </span>
      </main>
    );
  }
  if (state === "unavailable" || !fixture) {
    return (
      <main
        className="ms-match-hub ms-match-hub--unavailable"
        id="main-content"
      >
        {onBack ? (
          <button onClick={onBack} type="button">
            Back to match day
          </button>
        ) : null}
        <p>Match data unavailable</p>
        <span>
          This fixture is not currently available from the MatchSense server.
        </span>
      </main>
    );
  }

  const home = teamFor(catalog, fixture.homeTeam, fixture.homeTeamName);
  const away = teamFor(catalog, fixture.awayTeam, fixture.awayTeamName);
  const status = freshnessLabel(fixture);
  const freshness = formatFreshness(
    fixture.updatedAt,
    new Date().toISOString(),
  );
  const isLive = status === "LIVE";
  const lastEvent = fixture.lastEvent;
  const score = fixture.score;

  return (
    <main className="ms-match-hub" id="main-content">
      <header className="ms-match-hub-header">
        {onBack ? (
          <button onClick={onBack} type="button">
            Match day
          </button>
        ) : (
          <a href="/">MatchSense</a>
        )}
        <span>{fixture.competition ?? "World Cup"}</span>
      </header>
      <section
        className="ms-match-hub-score"
        aria-label={`${home.name} versus ${away.name}`}
      >
        <div
          className="ms-match-hub-status"
          data-state={isLive ? "live" : "honest"}
        >
          <i aria-hidden="true" />
          <span>{status}</span>
          <small>{freshness}</small>
        </div>
        <div className="ms-match-hub-teams">
          <div>
            <TeamFlag size="hero" team={home} />
            <b>{home.name}</b>
            <small>{home.code}</small>
          </div>
          {score ? (
            <strong>
              <span>{score.home}</span>
              <i>—</i>
              <span>{score.away}</span>
              <small>{fixture.minute}</small>
            </strong>
          ) : (
            <span className="ms-match-hub-score-pending">
              SCORE NOT PUBLISHED
            </span>
          )}
          <div>
            <TeamFlag size="hero" team={away} />
            <b>{away.name}</b>
            <small>{away.code}</small>
          </div>
        </div>
        <p>
          {favoriteTeam &&
          (favoriteTeam === home.code || favoriteTeam === away.code)
            ? "Your team is on this match card."
            : "This score comes from the current server snapshot."}
        </p>
      </section>
      <section className="ms-match-hub-utilities" aria-label="Match services">
        <article>
          <span>FOLLOW &amp; ALERTS</span>
          <b>Connection required</b>
          <p>
            Follow controls appear after the server confirms this fixture is
            followable.
          </p>
        </article>
        <article>
          <span>LISTENING</span>
          <b>Stream unavailable</b>
          <p>
            Listening stays hidden until a durable commentary stream is attached
            to this match.
          </p>
        </article>
        <article>
          <span>ROOMS</span>
          <b>
            {fixture.lifecycle === "SCHEDULED"
              ? "Pre-match eligibility pending"
              : "Unavailable for this lifecycle"}
          </b>
          <p>
            Room actions are enabled only from server-qualified match rules.
          </p>
        </article>
      </section>
      <section
        className="ms-match-hub-timeline"
        aria-labelledby="timeline-title"
      >
        <header>
          <div>
            <p>CANONICAL TIMELINE</p>
            <h2 id="timeline-title">What changed</h2>
          </div>
          <span>{fixture.sourceLabel ?? "MATCHSENSE SERVER DATA"}</span>
        </header>
        {lastEvent ? (
          <article>
            <time>{lastEvent.minute}</time>
            <div>
              <b>{eventLabel(lastEvent)}</b>
              <span>
                {lastEvent.detail ??
                  "A canonical event was published for this match."}
              </span>
            </div>
            <em>{lastEvent.status}</em>
            {onOpenMoment ? (
              <button
                onClick={() => onOpenMoment(lastEvent.identity)}
                type="button"
              >
                Open current Moment
              </button>
            ) : null}
          </article>
        ) : (
          <p className="ms-match-hub-no-event">
            No canonical event has been published for this snapshot.
          </p>
        )}
      </section>
    </main>
  );
}
