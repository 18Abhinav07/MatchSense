import { TeamFlag } from "../../components/TeamFlag.js";
import {
  eventLabel,
  fallbackTeam,
  type ProductCatalog,
} from "../../live-api.js";
import type { LiveMoment, LiveSnapshot } from "../../product-state.js";

function momentTone(moment: LiveMoment) {
  if (moment.status === "under_review" || moment.status === "provisional") {
    return "review";
  }
  if (moment.status === "overturned" || moment.kind === "var.overturned") {
    return "overturned";
  }
  if (moment.kind === "card.red") return "red";
  if (moment.kind === "card.yellow") return "yellow";
  if (moment.celebratesGoal) return "goal";
  return "neutral";
}

function momentCopy(moment: LiveMoment) {
  const tone = momentTone(moment);
  if (tone === "review") {
    return {
      body: "Celebration held. MatchSense waits for the next canonical revision.",
      title: "Under review",
    };
  }
  if (tone === "overturned") {
    return {
      body: "No goal. The score has returned to the confirmed match truth.",
      title: "Overturned",
    };
  }
  if (moment.kind === "var.stands") {
    return {
      body: "The review is complete. The goal now belongs to the match.",
      title: "The goal stands",
    };
  }
  if (tone === "red") {
    return {
      body: "A player is off. The shape of the match just changed.",
      title: "Red card",
    };
  }
  if (tone === "yellow") {
    return { body: "The referee reaches for the book.", title: "Yellow card" };
  }
  if (moment.kind === "phase.full_time") {
    return {
      body: "The final fact is committed. Your Match Memory is ready.",
      title: "Full time",
    };
  }
  if (moment.celebratesGoal) {
    return { body: "Confirmed. Now the celebration can begin.", title: "Goal" };
  }
  return {
    body: moment.detail ?? "The canonical match state has changed.",
    title: eventLabel(moment),
  };
}

export function ExperienceMoment({
  catalog,
  moment,
  onClose,
  snapshot,
}: {
  catalog: ProductCatalog;
  moment: LiveMoment;
  onClose(): void;
  snapshot: LiveSnapshot;
}) {
  const copy = momentCopy(moment);
  const tone = momentTone(moment);
  const eventTeam =
    typeof moment.eventTeam === "string" && moment.eventTeam
      ? moment.eventTeam
      : null;
  const team = eventTeam
    ? (catalog.teams.find((candidate) => candidate.code === eventTeam) ??
      fallbackTeam(eventTeam))
    : null;
  const score = snapshot.score ?? moment.score;
  return (
    <div
      aria-label={`${copy.title} Moment`}
      aria-live="assertive"
      className="ms-experience-moment"
      data-tone={tone}
      role="dialog"
    >
      <div className="ms-experience-moment__pitch" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <header>
        <span>EXPERIENCE · CURRENT REVISION</span>
        <button onClick={onClose} type="button">
          Return to match
        </button>
      </header>
      <section>
        <div className="ms-experience-moment__fact">
          <small>
            {moment.minute} · REVISION {moment.revision}
          </small>
          <strong>
            {snapshot.homeTeam} {score.home}—{score.away} {snapshot.awayTeam}
          </strong>
        </div>
        <div className="ms-experience-moment__copy">
          <p>
            {moment.status === "confirmed"
              ? "CONFIRMED MATCH FACT"
              : "TRUTH GATE ACTIVE"}
          </p>
          <h1>{copy.title}</h1>
          <span>{copy.body}</span>
        </div>
        {team ? (
          <TeamFlag
            className="ms-experience-moment__flag"
            size="hero"
            team={team}
          />
        ) : (
          <div className="ms-experience-moment__match-mark" aria-hidden="true">
            <span>{snapshot.homeTeam}</span>
            <i>FULL TIME</i>
            <span>{snapshot.awayTeam}</span>
          </div>
        )}
      </section>
      <footer>
        SIMULATED TXLINE-SHAPED DATA · EXACT MOMENT {moment.identity}
      </footer>
    </div>
  );
}
