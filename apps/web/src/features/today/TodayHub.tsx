import type { ProductCatalog } from "../../live-api.js";
import { todayFixtureBucket } from "../../live-api.js";
import type { LiveSnapshot } from "../../product-state.js";

import { FixtureCard, type FixtureCardTone } from "./FixtureCard.js";
import "./today.css";

export type TodayHubState = "loading" | "ready" | "unavailable";

export interface TodayHubProps {
  catalog: ProductCatalog;
  favoriteTeam: string | null;
  fixtures: readonly LiveSnapshot[];
  onOpenFixture(fixtureId: string): void;
  onOpenProfile(): void;
  onOpenReplays?: (() => void) | undefined;
  state: TodayHubState;
}

function byFavoriteTeam(favoriteTeam: string | null) {
  return (left: LiveSnapshot, right: LiveSnapshot) => {
    const leftFavorite =
      left.homeTeam === favoriteTeam || left.awayTeam === favoriteTeam ? 1 : 0;
    const rightFavorite =
      right.homeTeam === favoriteTeam || right.awayTeam === favoriteTeam
        ? 1
        : 0;
    return rightFavorite - leftFavorite;
  };
}

function FixtureSection({
  catalog,
  fixtures,
  onOpenFixture,
  title,
  tone,
}: {
  catalog: ProductCatalog;
  fixtures: readonly LiveSnapshot[];
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
  const order = byFavoriteTeam(favoriteTeam);
  buckets.live.sort(order);
  buckets.upcoming.sort(order);
  buckets.verified_final.sort(order);

  return (
    <main className="ms-today" id="main-content">
      <header className="ms-today-masthead">
        <a aria-label="MatchSense home" href="/">
          Match<span>Sense</span>
        </a>
        <div>
          <span>World Cup match desk</span>
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
          <b>
            {favoriteTeam
              ? "Your team is prioritised"
              : "Choose a team in your profile"}
          </b>
          <span>Nothing is inferred from the clock.</span>
        </aside>
      </section>
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
            {...{ catalog, onOpenFixture }}
            fixtures={buckets.live}
            title="Live now"
            tone="live"
          />
          <FixtureSection
            {...{ catalog, onOpenFixture }}
            fixtures={buckets.upcoming}
            title="Upcoming"
            tone="upcoming"
          />
          <FixtureSection
            {...{ catalog, onOpenFixture }}
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
