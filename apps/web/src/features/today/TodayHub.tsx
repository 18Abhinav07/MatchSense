import type { ProductCatalog } from "../../live-api.js";
import { todayFixtureBucket } from "../../live-api.js";
import type { LiveSnapshot } from "../../product-state.js";
import { TeamFlag } from "../../components/TeamFlag.js";

import { FixtureCard, type FixtureCardTone } from "./FixtureCard.js";
import "./today.css";

export type TodayHubState = "loading" | "ready" | "unavailable";

export interface TodayHubProps {
  catalog: ProductCatalog;
  favoriteTeam: string | null;
  fixtures: readonly LiveSnapshot[];
  onOpenExperience?: (() => void) | undefined;
  onOpenFixture(fixtureId: string): void;
  onOpenProfile(): void;
  onOpenReplays?: (() => void) | undefined;
  state: TodayHubState;
}

function byFavoriteTeam(favoriteTeam: string | null, newestFirst = false) {
  return (left: LiveSnapshot, right: LiveSnapshot) => {
    const leftFavorite =
      left.homeTeam === favoriteTeam || left.awayTeam === favoriteTeam ? 1 : 0;
    const rightFavorite =
      right.homeTeam === favoriteTeam || right.awayTeam === favoriteTeam
        ? 1
        : 0;
    const favoriteDifference = rightFavorite - leftFavorite;
    if (favoriteDifference) return favoriteDifference;
    const leftTime = Date.parse(left.kickoffAt ?? left.updatedAt ?? "");
    const rightTime = Date.parse(right.kickoffAt ?? right.updatedAt ?? "");
    const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
    const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
    return newestFirst ? safeRight - safeLeft : safeLeft - safeRight;
  };
}

function FixtureSection({
  catalog,
  fixtures,
  favoriteTeam,
  onOpenFixture,
  title,
  tone,
}: {
  catalog: ProductCatalog;
  fixtures: readonly LiveSnapshot[];
  favoriteTeam: string | null;
  onOpenFixture(fixtureId: string): void;
  title: string;
  tone: FixtureCardTone;
}) {
  if (!fixtures.length) return null;
  return (
    <section className="ms-today-section" aria-labelledby={`today-${tone}`}>
      <header>
        <h2 id={`today-${tone}`}>{title}</h2>
        <span>
          {fixtures.length} match{fixtures.length === 1 ? "" : "es"}
        </span>
      </header>
      <div className="ms-today-fixture-list">
        {fixtures.map((fixture) => (
          <FixtureCard
            catalog={catalog}
            fixture={fixture}
            favoriteTeam={favoriteTeam}
            key={fixture.fixtureId}
            onOpen={onOpenFixture}
            tone={tone}
          />
        ))}
      </div>
    </section>
  );
}

export function TodayHub({
  catalog,
  favoriteTeam,
  fixtures,
  onOpenExperience,
  onOpenFixture,
  onOpenProfile,
  onOpenReplays,
  state,
}: TodayHubProps) {
  const buckets = {
    live: fixtures.filter((fixture) => todayFixtureBucket(fixture) === "live"),
    upcoming: fixtures.filter(
      (fixture) => todayFixtureBucket(fixture) === "upcoming",
    ),
    verified_final: fixtures.filter(
      (fixture) => todayFixtureBucket(fixture) === "verified_final",
    ),
  };
  buckets.live.sort(byFavoriteTeam(favoriteTeam));
  buckets.upcoming.sort(byFavoriteTeam(favoriteTeam));
  buckets.verified_final.sort(byFavoriteTeam(favoriteTeam, true));
  const favorite =
    catalog.teams.find((team) => team.code === favoriteTeam) ?? null;

  return (
    <main className="ms-today" id="main-content">
      <header className="ms-today-masthead">
        <a aria-label="MatchSense home" href="/">
          Match<span>Sense</span>
        </a>
        <div>
          <button
            aria-label="Your profile"
            onClick={onOpenProfile}
            type="button"
          >
            Your profile
          </button>
          {onOpenReplays ? (
            <button onClick={onOpenReplays} type="button">
              Recorded replays
            </button>
          ) : null}
        </div>
      </header>
      <section className="ms-today-hero">
        <div>
          <p>YOUR MATCH DAY</p>
          <h1>Follow what is actually on the pitch.</h1>
          <span>
            Live scores, scheduled matches and verified final records from the
            MatchSense server.
          </span>
        </div>
        <aside>
          {favorite ? <TeamFlag size="hero" team={favorite} /> : null}
          <span>
            <b>
              {favorite
                ? `${favorite.name} first`
                : "Choose a team in your profile"}
            </b>
            <small>Only source-qualified matches appear.</small>
          </span>
        </aside>
      </section>
      {onOpenExperience ? (
        <section
          className="ms-today-experience"
          aria-labelledby="experience-title"
        >
          <div>
            <p>ALWAYS AVAILABLE · FIVE MINUTES</p>
            <h2 id="experience-title">Feel a complete match right now.</h2>
            <span>
              Goals, cards, two honest VAR decisions, lock-screen alerts and
              Pocket Listening in one server-owned Experience match.
            </span>
          </div>
          <button onClick={onOpenExperience} type="button">
            <span>Enter Experience</span>
            <small>SIMULATED TXLINE-SHAPED DATA</small>
          </button>
        </section>
      ) : null}
      {state === "loading" ? (
        <section className="ms-today-loading" aria-live="polite">
          <span />
          <span />
          <span />
          <p>Opening the match schedule</p>
        </section>
      ) : state === "unavailable" ? (
        <section className="ms-today-unavailable" role="status">
          <p>Match schedule unavailable</p>
          <span>
            We will show server-qualified matches when the schedule connection
            returns.
          </span>
        </section>
      ) : buckets.live.length ||
        buckets.upcoming.length ||
        buckets.verified_final.length ? (
        <div className="ms-today-content">
          <FixtureSection
            {...{ catalog, favoriteTeam, onOpenFixture }}
            fixtures={buckets.live}
            title="Live now"
            tone="live"
          />
          <FixtureSection
            {...{ catalog, favoriteTeam, onOpenFixture }}
            fixtures={buckets.upcoming}
            title="Upcoming"
            tone="upcoming"
          />
          <FixtureSection
            {...{ catalog, favoriteTeam, onOpenFixture }}
            fixtures={buckets.verified_final}
            title="Verified finals"
            tone="verified_final"
          />
        </div>
      ) : (
        <section className="ms-today-unavailable" role="status">
          <p>No eligible matches yet</p>
          <span>
            Only live, scheduled, and archive-verified final rows appear here.
          </span>
        </section>
      )}
    </main>
  );
}
