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
  onOpen,
  tone,
}: {
  catalog: ProductCatalog;
  fixture: LiveSnapshot;
  onOpen(fixtureId: string): void;
  tone: FixtureCardTone;
}) {
  const home = teamFor(catalog, fixture.homeTeam, fixture.homeTeamName);
  const away = teamFor(catalog, fixture.awayTeam, fixture.awayTeamName);
  const scoreVisible = tone !== "upcoming" && fixture.score !== null;
  const detail =
    tone === "live"
      ? fixture.minute
      : tone === "verified_final"
        ? "FT · archive verified"
        : kickoffLabel(fixture.kickoffAt);

  return (
    <article
      className={`ms-fixture-card ms-fixture-card--${tone}`}
      data-fixture-id={fixture.fixtureId}
    >
      <div className="ms-fixture-card-meta">
        <span>{labels[tone]}</span>
        <small>{detail}</small>
      </div>
      <button
        aria-label={`Open ${home.name} versus ${away.name}`}
        onClick={() => onOpen(fixture.fixtureId)}
        type="button"
      >
        <span className="ms-fixture-card-team ms-fixture-card-team--home">
          <TeamFlag size="standard" team={home} />
          <b>{home.name}</b>
          <small>{home.code}</small>
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
          <b>{away.name}</b>
          <small>{away.code}</small>
        </span>
      </button>
    </article>
  );
}
