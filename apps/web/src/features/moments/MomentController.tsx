import { TeamFlag } from "../../components/TeamFlag.js";
import {
  eventLabel,
  fallbackTeam,
  type MomentResolution,
  type ProductCatalog,
  type ProductTeam,
} from "../../live-api.js";

import "./moment-controller.css";

export interface MomentControllerProps {
  catalog: ProductCatalog;
  onClose(): void;
  resolution: MomentResolution;
}

type MomentTone = "goal" | "neutral" | "red" | "var" | "yellow";

interface MomentPresentation {
  body: string;
  eyebrow: string;
  tone: MomentTone;
}

function teamFor(catalog: ProductCatalog, code: string): ProductTeam {
  return catalog.teams.find((team) => team.code === code) ?? fallbackTeam(code);
}

function presentationFor(
  moment: MomentResolution["latest"],
): MomentPresentation {
  if (!moment) {
    return {
      body: "The current revision could not be loaded from the MatchSense server.",
      eyebrow: "MOMENT UNAVAILABLE",
      tone: "neutral",
    };
  }

  const kind = moment.kind.toLowerCase();
  const status = moment.status.toLowerCase();

  if (status === "under_review" || status === "provisional") {
    return {
      body: "Celebration held while the official review is in progress.",
      eyebrow: "UNDER REVIEW",
      tone: "var",
    };
  }
  if (status === "overturned" || kind.includes("overturned")) {
    return {
      body: "The score has been rolled back to the latest verified revision.",
      eyebrow: "No goal — overturned.",
      tone: "var",
    };
  }
  if (kind.includes("var.stands") || kind.includes("var_stands")) {
    return {
      body: "The reviewed decision is now the current verified match truth.",
      eyebrow: "The goal stands.",
      tone: "var",
    };
  }
  if (kind.includes("yellow")) {
    return {
      body: moment.detail ?? "A yellow card has been confirmed.",
      eyebrow: "Yellow card",
      tone: "yellow",
    };
  }
  if (kind.includes("red")) {
    return {
      body: moment.detail ?? "A red card has been confirmed.",
      eyebrow: "Red card",
      tone: "red",
    };
  }
  if (kind.includes("goal") || moment.celebratesGoal) {
    return {
      body: moment.detail ?? "The goal is confirmed in the current revision.",
      eyebrow: "GOAL CONFIRMED",
      tone: "goal",
    };
  }
  return {
    body: moment.detail ?? "A canonical match event was confirmed.",
    eyebrow: moment.title ?? eventLabel(moment),
    tone: "neutral",
  };
}

function scoreText(resolution: MomentResolution) {
  const score = resolution.snapshot.score ?? resolution.latest?.score;
  if (!score) return "SCORE NOT PUBLISHED";
  return `${resolution.snapshot.homeTeam} ${score.home}—${score.away} ${resolution.snapshot.awayTeam}`;
}

export function MomentController({
  catalog,
  onClose,
  resolution,
}: MomentControllerProps) {
  const latest = resolution.latest;
  const current = presentationFor(latest);
  const home = teamFor(catalog, resolution.snapshot.homeTeam);
  const away = teamFor(catalog, resolution.snapshot.awayTeam);
  const eventTeam = latest ? teamFor(catalog, latest.eventTeam) : null;

  return (
    <main
      className="ms-moment-controller"
      data-tone={current.tone}
      id="main-content"
    >
      <header className="ms-moment-controller__header">
        <button onClick={onClose} type="button">
          Back to match
        </button>
        <span>{resolution.snapshot.sourceLabel ?? "TXLINE MATCH DATA"}</span>
      </header>

      <section
        aria-label="Current match score"
        className="ms-moment-controller__fact"
      >
        <div className="ms-moment-controller__teams" aria-hidden="true">
          <TeamFlag size="compact" team={home} />
          <TeamFlag size="compact" team={away} />
        </div>
        <strong>{scoreText(resolution)}</strong>
        <span>{resolution.snapshot.minute} · CURRENT MATCH FACT</span>
      </section>

      <section className="ms-moment-controller__moment" aria-live="polite">
        <div className="ms-moment-controller__pulse" aria-hidden="true" />
        <div className="ms-moment-controller__copy">
          <span className="ms-moment-controller__kicker">CURRENT REVISION</span>
          <h1>{current.eyebrow}</h1>
          <p>{current.body}</p>
          {latest ? (
            <dl>
              <div>
                <dt>MINUTE</dt>
                <dd>{latest.minute}</dd>
              </div>
              <div>
                <dt>EVENT</dt>
                <dd>{eventTeam?.name ?? latest.eventTeam}</dd>
              </div>
              <div>
                <dt>REVISION</dt>
                <dd>Current revision {latest.revision}</dd>
              </div>
            </dl>
          ) : null}
        </div>
        {eventTeam ? (
          <TeamFlag
            className="ms-moment-controller__event-flag"
            size="hero"
            team={eventTeam}
          />
        ) : null}
      </section>

      {resolution.superseded ? (
        <aside className="ms-moment-controller__revision" role="status">
          <strong>Requested revision superseded</strong>
          <span>
            MatchSense has opened the current truth instead of replaying an old
            notification.
          </span>
        </aside>
      ) : null}
    </main>
  );
}
