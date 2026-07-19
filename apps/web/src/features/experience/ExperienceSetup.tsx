import { TeamFlag } from "../../components/TeamFlag.js";
import type { ProductCatalog } from "../../live-api.js";

export function ExperienceSetup({
  catalog,
  error,
  favoriteTeam,
  onBack,
  onCreateRoom,
  onEnableAlerts,
  onStart,
  pushState,
  starting,
}: {
  catalog: ProductCatalog;
  error: string | null;
  favoriteTeam: string | null;
  onBack(): void;
  onCreateRoom(input: { awayTeam: string; homeTeam: string }): void;
  onEnableAlerts(): void;
  onStart(input: { awayTeam: string; homeTeam: string }): void;
  pushState: "idle" | "enabling" | "enabled" | "unavailable";
  starting: boolean;
}) {
  const home =
    catalog.teams.find((team) => team.code === favoriteTeam) ??
    catalog.teams.find((team) => team.code === "ARG") ??
    catalog.teams[0];
  const away =
    catalog.teams.find(
      (team) => team.code !== home?.code && team.code === "FRA",
    ) ?? catalog.teams.find((team) => team.code !== home?.code);

  return (
    <main className="ms-experience ms-experience--setup" id="main-content">
      <header className="ms-experience__masthead">
        <button onClick={onBack} type="button">
          Match day
        </button>
        <span>EXPERIENCE · SIMULATED TXLINE-SHAPED DATA</span>
      </header>
      <section className="ms-experience-setup">
        <div className="ms-experience-setup__copy">
          <p>THE COMPLETE MATCHSENSE LOOP</p>
          <h1>Five minutes. Every match-day feeling.</h1>
          <span>
            A permanently available match for your chosen team that exercises
            factual Moments, VAR restraint, Pocket Listening, Web Push and a
            verified final record using the same contracts as the live product.
          </span>
        </div>
        <div
          className="ms-experience-setup__fixture"
          aria-label="Experience fixture"
        >
          {home ? <TeamFlag size="hero" team={home} /> : null}
          <div>
            <small>KICKOFF AFTER START</small>
            <strong>{home?.code ?? "ARG"}</strong>
            <i>versus</i>
            <strong>{away?.code ?? "FRA"}</strong>
          </div>
          {away ? <TeamFlag size="hero" team={away} /> : null}
        </div>
      </section>
      <section
        className="ms-experience-readiness"
        aria-label="Experience readiness"
      >
        <article>
          <span>01</span>
          <b>Keep this screen open</b>
          <p>
            Foreground Moments take over this surface as canonical facts land.
          </p>
        </article>
        <article>
          <span>02</span>
          <b>Enable factual alerts</b>
          <p>
            Installed PWAs receive real OS notifications for goals, red cards
            and full-time.
          </p>
          <button
            disabled={pushState === "enabling" || pushState === "enabled"}
            onClick={onEnableAlerts}
            type="button"
          >
            {pushState === "enabled"
              ? "Alerts enabled"
              : pushState === "enabling"
                ? "Enabling alerts"
                : pushState === "unavailable"
                  ? "Continue without alerts"
                  : "Enable alerts"}
          </button>
        </article>
        <article>
          <span>03</span>
          <b>Start Pocket Listening</b>
          <p>
            The match surface prepares one continuous audio stream you can keep
            playing while locked.
          </p>
        </article>
      </section>
      {error ? (
        <p className="ms-experience-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="ms-experience-launch"
        disabled={!home || !away || starting}
        onClick={() =>
          home && away && onStart({ homeTeam: home.code, awayTeam: away.code })
        }
        type="button"
      >
        <span>
          {starting ? "Preparing server match" : "Start five-minute match"}
        </span>
        <small>SOLO EXPERIENCE · SAME MOMENT AND AUDIO CONTRACTS</small>
      </button>
      <button
        className="ms-experience-launch ms-experience-launch--room"
        disabled={!home || !away || starting}
        onClick={() =>
          home &&
          away &&
          onCreateRoom({ homeTeam: home.code, awayTeam: away.code })
        }
        type="button"
      >
        <span>Create a five-minute friend room</span>
        <small>INVITE · CALL THREE · REACT · FINAL POINTS</small>
      </button>
    </main>
  );
}
