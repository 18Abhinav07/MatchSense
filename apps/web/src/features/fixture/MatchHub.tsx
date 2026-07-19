import { TeamFlag } from "../../components/TeamFlag.js";
import {
  eventLabel,
  type ProductCatalog,
  type ProductTeam,
} from "../../live-api.js";
import {
  formatFreshness,
  type LiveMoment,
  type LiveSnapshot,
  type LiveViewState,
} from "../../product-state.js";
import { ListeningControl } from "../listening/ListeningControl.js";

import "./match-hub.css";

export type MatchHubState = "loading" | "ready" | "unavailable";
export type MatchHubAlertState = "idle" | "enabling" | "enabled" | "error";
export type MatchHubFollowState = "idle" | "saving" | "error";

export interface MatchHubProps {
  alertState?: MatchHubAlertState | undefined;
  catalog: ProductCatalog;
  favoriteTeam: string | null;
  fixture: LiveSnapshot | null;
  followed?: boolean | undefined;
  followState?: MatchHubFollowState | undefined;
  onBack?: (() => void) | undefined;
  onEnableAlerts?: (() => void) | undefined;
  onFollow?: (() => void) | undefined;
  onOpenMoment?: ((identity: string) => void) | undefined;
  onUnfollow?: (() => void) | undefined;
  state: MatchHubState;
  timeline?: readonly LiveMoment[] | undefined;
  transportHealth?: LiveViewState["transportHealth"] | undefined;
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

function kickoffLabel(value: string | undefined) {
  if (!value) return "Kickoff time pending";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Kickoff time pending";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

function freshnessLabel(
  fixture: LiveSnapshot,
  transportHealth: LiveViewState["transportHealth"] | undefined,
) {
  if (transportHealth === "offline") return "OFFLINE";
  if (transportHealth === "stale") return "RECONNECTING";
  if (fixture.lifecycle === "FINAL" || fixture.lifecycle === "FINAL_REVISED") {
    return fixture.archiveStatus === "REPLAY_READY"
      ? "VERIFIED FINAL"
      : "FINAL AWAITING ARCHIVE";
  }
  if (fixture.lifecycle === "TERMINAL_FACT_COMMITTED") {
    return "FINALISING RESULT";
  }
  if (transportHealth === "connecting" && fixture.lifecycle === "LIVE") {
    return "CONNECTING";
  }
  if (
    fixture.lifecycle === "LIVE" &&
    (fixture.freshness === "live" ||
      (fixture.freshness === undefined && transportHealth === "reconciled"))
  ) {
    return "LIVE";
  }
  if (fixture.freshness === "cached") return "CACHED DATA";
  if (fixture.freshness === "stale") return "STALE DATA";
  if (fixture.freshness === "offline") return "OFFLINE";
  if (fixture.lifecycle === "SCHEDULED" || fixture.lifecycle === "TRACKING") {
    return "UPCOMING";
  }
  return "MATCH STATUS PENDING";
}

export function MatchHub({
  alertState = "idle",
  catalog,
  favoriteTeam,
  fixture,
  followed = false,
  followState = "idle",
  onBack,
  onEnableAlerts,
  onFollow,
  onOpenMoment,
  onUnfollow,
  state,
  timeline = [],
  transportHealth,
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
  const status = freshnessLabel(fixture, transportHealth);
  const freshness = formatFreshness(
    fixture.updatedAt,
    new Date().toISOString(),
  );
  const isLive = status === "LIVE";
  const lastEvent = fixture.lastEvent;
  const eventRail = timeline.length
    ? timeline.slice(-20)
    : lastEvent
      ? [lastEvent]
      : [];
  const score = fixture.score;
  const scheduled =
    fixture.lifecycle === "SCHEDULED" || fixture.lifecycle === "TRACKING";
  const followable =
    fixture.provenance === "live_txline" &&
    fixture.mode !== "recorded" &&
    !fixture.fixtureId.startsWith("experience:") &&
    (scheduled || fixture.lifecycle === "LIVE");
  const perspectiveTeam =
    favoriteTeam === home.code || favoriteTeam === away.code
      ? favoriteTeam
      : home.code;
  const listeningMoment = lastEvent
    ? {
        familyId: lastEvent.id,
        fixtureId: fixture.fixtureId,
        revision: lastEvent.revision,
        text:
          lastEvent.detail ??
          `${eventLabel(lastEvent)} confirmed at ${lastEvent.minute}.`,
      }
    : null;

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
          ) : scheduled ? (
            <span className="ms-match-hub-kickoff">
              <b>{kickoffLabel(fixture.kickoffAt)}</b>
              <small>Kickoff</small>
            </span>
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
      <section className="ms-match-hub-facts" aria-label="Match facts">
        <article>
          <span>COMPETITION</span>
          <b>{fixture.competition ?? "World Cup"}</b>
        </article>
        <article>
          <span>{scheduled ? "KICKOFF" : "MATCH CLOCK"}</span>
          <b>{scheduled ? kickoffLabel(fixture.kickoffAt) : fixture.minute}</b>
        </article>
        <article>
          <span>SOURCE</span>
          <b>{fixture.sourceLabel ?? "TXLINE MATCH DATA"}</b>
        </article>
      </section>
      {followable && onFollow && onUnfollow && onEnableAlerts ? (
        <section
          className="ms-match-hub-follow"
          aria-labelledby="match-follow-title"
        >
          <div>
            <span>LIVE MATCH ALERTS</span>
            <h2 id="match-follow-title">Stay with this match</h2>
            <p>
              Follow this fixture, then enable factual OS alerts for Goals · red
              cards · full-time.
            </p>
          </div>
          <div className="ms-match-hub-follow-actions">
            <button
              disabled={followState === "saving"}
              onClick={followed ? onUnfollow : onFollow}
              type="button"
            >
              {followState === "saving"
                ? "Saving…"
                : followed
                  ? "Unfollow match"
                  : "Follow match"}
            </button>
            <button
              className="ms-match-hub-alert-button"
              disabled={
                !followed ||
                alertState === "enabling" ||
                alertState === "enabled"
              }
              onClick={onEnableAlerts}
              type="button"
            >
              {alertState === "enabling"
                ? "Enabling…"
                : alertState === "enabled"
                  ? "OS alerts enabled"
                  : "Enable OS alerts"}
            </button>
          </div>
          {followState === "error" || alertState === "error" ? (
            <p className="ms-match-hub-follow-error" role="status">
              {followState === "error"
                ? "MatchSense could not update this follow. Try again."
                : "OS alerts could not be enabled on this device. Try again."}
            </p>
          ) : !followed ? (
            <small>
              Follow the match before asking this device for permission.
            </small>
          ) : null}
        </section>
      ) : null}
      <ListeningControl
        fixtureId={fixture.fixtureId}
        moment={listeningMoment}
        perspectiveTeam={perspectiveTeam}
      />
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
        {eventRail.length ? (
          <div className="ms-match-hub-event-rail">
            {eventRail.map((event) => (
              <article key={event.identity}>
                <time>{event.minute}</time>
                <div>
                  <b>{eventLabel(event)}</b>
                  <span>
                    {event.detail ??
                      `${eventLabel(event)} confirmed at ${event.minute}.`}
                  </span>
                </div>
                <em>{event.status}</em>
                {onOpenMoment ? (
                  <button
                    onClick={() => onOpenMoment(event.identity)}
                    type="button"
                  >
                    Open Moment
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="ms-match-hub-no-event">
            {scheduled
              ? "Match events begin when TxLINE publishes them."
              : "No canonical event has been published for this snapshot."}
          </p>
        )}
      </section>
    </main>
  );
}
