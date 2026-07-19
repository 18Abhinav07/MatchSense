import { useEffect, useMemo, useState } from "react";

import { TeamFlag } from "../../components/TeamFlag.js";
import {
  eventLabel,
  fallbackTeam,
  type ProductCatalog,
} from "../../live-api.js";
import type { LiveMoment, LiveSnapshot } from "../../product-state.js";
import { ExperienceMoment } from "./ExperienceMoment.js";

export interface ExperienceTranscript {
  momentIdentity: string;
  text: string;
}

function isReplayMoment(moment: LiveMoment) {
  return (
    moment.celebratesGoal ||
    moment.kind.startsWith("var.") ||
    moment.kind === "card.red" ||
    moment.kind === "phase.full_time"
  );
}

export function ExperienceMemory({
  catalog,
  fixture,
  onClose,
  onRestart,
  timeline,
  transcripts,
}: {
  catalog: ProductCatalog;
  fixture: LiveSnapshot;
  onClose(): void;
  onRestart(): void;
  timeline: readonly LiveMoment[];
  transcripts: readonly ExperienceTranscript[];
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const replayMoments = useMemo(
    () => timeline.filter(isReplayMoment),
    [timeline],
  );
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const replayMoment =
    replayIndex === null ? null : (replayMoments[replayIndex] ?? null);
  const home =
    catalog.teams.find((team) => team.code === fixture.homeTeam) ??
    fallbackTeam(fixture.homeTeam);
  const away =
    catalog.teams.find((team) => team.code === fixture.awayTeam) ??
    fallbackTeam(fixture.awayTeam);
  const score = fixture.score ?? { away: 1, home: 2 };

  useEffect(() => {
    if (replayIndex === null) return;
    if (replayIndex >= replayMoments.length - 1) {
      const timer = setTimeout(() => setReplayIndex(null), 3_000);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(
      () => setReplayIndex((value) => (value ?? 0) + 1),
      3_000,
    );
    return () => clearTimeout(timer);
  }, [replayIndex, replayMoments.length]);

  useEffect(() => {
    if (
      !replayMoment ||
      !("speechSynthesis" in globalThis) ||
      !("SpeechSynthesisUtterance" in globalThis)
    ) {
      return;
    }
    const transcript = transcripts.find(
      (entry) => entry.momentIdentity === replayMoment.identity,
    );
    const call =
      transcript?.text ?? replayMoment.detail ?? eventLabel(replayMoment);
    globalThis.speechSynthesis.cancel();
    globalThis.speechSynthesis.speak(new SpeechSynthesisUtterance(call));
    return () => globalThis.speechSynthesis.cancel();
  }, [replayMoment, transcripts]);

  const share = async () => {
    const text = `${home.name} ${score.home}–${score.away} ${away.name}. My MatchSense Experience: three goals, five cards and two honest VAR decisions.`;
    try {
      if (navigator.share) {
        await navigator.share({
          text,
          title: "My MatchSense Memory",
          url: window.location.href,
        });
      } else {
        await navigator.clipboard.writeText(`${text} ${window.location.href}`);
      }
      setNotice("Memory ready to share");
    } catch {
      setNotice("Sharing was cancelled");
    }
  };

  return (
    <div
      className="ms-experience-memory"
      role="dialog"
      aria-label="Experience Match Memory"
    >
      <header>
        <button onClick={onClose} type="button">
          Back to final score
        </button>
        <span>EXPERIENCE MEMORY · SIMULATED TXLINE-SHAPED DATA</span>
      </header>
      <section className="ms-experience-memory__hero">
        <p>YOUR FIVE-MINUTE NIGHT</p>
        <h1>Two VAR holds. One winner. No fake celebration.</h1>
        <div>
          <TeamFlag size="hero" team={home} />
          <strong>
            {home.code} {score.home}
            <i>—</i>
            {score.away} {away.code}
          </strong>
          <TeamFlag size="hero" team={away} />
        </div>
      </section>
      <section className="ms-experience-memory__facts">
        <article>
          <b>3</b>
          <span>confirmed goals</span>
        </article>
        <article>
          <b>5</b>
          <span>cards shown</span>
        </article>
        <article>
          <b>2</b>
          <span>VAR decisions</span>
        </article>
        <article>
          <b>{timeline.length}</b>
          <span>truth revisions kept</span>
        </article>
      </section>
      <section className="ms-experience-memory__body">
        <div>
          <p>CANONICAL MATCH STORY</p>
          {timeline.map((moment) => (
            <article key={moment.identity} data-status={moment.status}>
              <time>{moment.minute}</time>
              <span>
                <b>{moment.title ?? eventLabel(moment)}</b>
                <small>
                  {moment.status} · revision {moment.revision}
                </small>
              </span>
            </article>
          ))}
        </div>
        <aside>
          <p>RADIO TRANSCRIPT</p>
          {transcripts.length ? (
            transcripts.map((entry) => (
              <blockquote key={entry.momentIdentity}>{entry.text}</blockquote>
            ))
          ) : (
            <span>
              Commentary appears here when Listening Mode has generated the
              match calls.
            </span>
          )}
        </aside>
      </section>
      <footer>
        <button
          disabled={!replayMoments.length}
          onClick={() => setReplayIndex(0)}
          type="button"
        >
          Replay key Moments with audio
        </button>
        <button onClick={() => void share()} type="button">
          Share this Memory
        </button>
        <button onClick={onRestart} type="button">
          Start a new Experience
        </button>
        {notice ? <span role="status">{notice}</span> : null}
      </footer>
      {replayMoment ? (
        <ExperienceMoment
          catalog={catalog}
          moment={replayMoment}
          onClose={() => setReplayIndex(null)}
          snapshot={{ ...fixture, score: replayMoment.score }}
        />
      ) : null}
    </div>
  );
}
