import { TeamFlag } from "../../components/TeamFlag.js";
import type { ProductCatalog, ProductTeam } from "../../live-api.js";
import type { LiveSnapshot } from "../../product-state.js";

export type FixtureCardTone = "live" | "upcoming" | "verified_final";

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
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

const labels: Record<FixtureCardTone, string> = {
  live: "Live now",
  upcoming: "Upcoming",
  verified_final: "Verified final",
};

export function FixtureCard({
  catalog,
  fixture,
  favoriteTeam,
  onOpen,
  tone,
}: {
  catalog: ProductCatalog;
  fixture: LiveSnapshot;
  favoriteTeam: string | null;
  onOpen(fixtureId: string): void;
  tone: FixtureCardTone;
}) {
  const home = teamFor(catalog, fixture.homeTeam, fixture.homeTeamName);
  const away = teamFor(catalog, fixture.awayTeam, fixture.awayTeamName);
  const scoreVisible = tone !== "upcoming" && fixture.score !== null;
  const isFavorite = favoriteTeam === home.code || favoriteTeam === away.code;
  const detail =
    tone === "live"
      ? fixture.minute
      : tone === "verified_final"
        ? "FT · archive verified"
        : kickoffLabel(fixture.kickoffAt);

  return (
    <article
      className={`ms-fixture-card ms-fixture-card--${tone}`}
      data-favorite-team={isFavorite}
      data-fixture-id={fixture.fixtureId}
    >
      <button
        aria-label={`Open ${home.name} versus ${away.name}`}
        onClick={() => onOpen(fixture.fixtureId)}
        type="button"
      >
        <span className="ms-fixture-card-meta">
          <span>{isFavorite ? "Your team" : labels[tone]}</span>
          <small>{detail}</small>
        </span>
        <span className="ms-fixture-card-team ms-fixture-card-team--home">
          <TeamFlag size="standard" team={home} />
          <span>
            <b>{home.name}</b>
            <small>{home.code}</small>
          </span>
        </span>
        <strong className="ms-fixture-card-score">
          {scoreVisible ? (
            <>
              <span>{fixture.score?.home}</span>
              <i>—</i>
              <span>{fixture.score?.away}</span>
            </>
          ) : tone !== "upcoming" ? (
            <span>SCORE PENDING</span>
          ) : (
            <span>vs</span>
          )}
        </strong>
        <span className="ms-fixture-card-team ms-fixture-card-team--away">
          <TeamFlag size="standard" team={away} />
          <span>
            <b>{away.name}</b>
            <small>{away.code}</small>
          </span>
        </span>
        <svg
          aria-hidden="true"
          className="ms-fixture-card-arrow"
          fill="none"
          viewBox="0 0 24 24"
        >
          <path
            d="M5 12h13M13 7l5 5-5 5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </button>
    </article>
  );
}
