import { useEffect, useMemo, useState } from "react";

import { TeamFlag } from "../../components/TeamFlag.js";
import {
  eventLabel,
  fallbackTeam,
  type ProductCatalog,
} from "../../live-api.js";
import type { LiveMoment, LiveSnapshot } from "../../product-state.js";
import { ListeningControl } from "../listening/ListeningControl.js";
import type { ExperienceRun } from "./experience-api.js";
import {
  ExperienceMemory,
  type ExperienceTranscript,
} from "./ExperienceMemory.js";
import { ExperienceMoment } from "./ExperienceMoment.js";

function secondsUntil(value: string) {
  return Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1_000));
}

export function ExperienceMatch({
  catalog,
  catchupCount,
  favoriteTeam,
  fixture,
  moment,
  onBack,
  onCloseMoment,
  onRestart,
  run,
  streamPaused,
  timeline,
  revisionHistory,
  transcripts,
}: {
  catalog: ProductCatalog;
  catchupCount: number;
  favoriteTeam: string | null;
  fixture: LiveSnapshot;
  moment: LiveMoment | null;
  onBack(): void;
  onCloseMoment(): void;
  onRestart(): void;
  run: ExperienceRun;
  streamPaused: boolean;
  timeline: readonly LiveMoment[];
  revisionHistory: readonly LiveMoment[];
  transcripts: readonly ExperienceTranscript[];
}) {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [countdown, setCountdown] = useState(() => secondsUntil(run.kickoffAt));
  useEffect(() => {
    const timer = setInterval(
      () => setCountdown(secondsUntil(run.kickoffAt)),
      250,
    );
    return () => clearInterval(timer);
  }, [run.kickoffAt]);

  const home =
    catalog.teams.find((team) => team.code === fixture.homeTeam) ??
    fallbackTeam(fixture.homeTeam);
  const away =
    catalog.teams.find((team) => team.code === fixture.awayTeam) ??
    fallbackTeam(fixture.awayTeam);
  const lastMoment = timeline.at(-1) ?? fixture.lastEvent ?? null;
  const lastTranscript = lastMoment
    ? (transcripts.find(
        (entry) => entry.momentIdentity === lastMoment.identity,
      ) ?? null)
    : null;
  const listeningMoment =
    lastMoment && lastTranscript
      ? {
          familyId: lastMoment.id,
          fixtureId: fixture.fixtureId,
          revision: lastMoment.revision,
          text: lastTranscript.text,
        }
      : null;
  const perspective =
    favoriteTeam === home.code || favoriteTeam === away.code
      ? favoriteTeam
      : home.code;
  const eventRail = useMemo(() => timeline.slice(-8).toReversed(), [timeline]);
  const score = fixture.score ?? { away: 0, home: 0 };
  const isFinal =
    run.status === "final" ||
    fixture.lifecycle === "FINAL" ||
    fixture.phase === "full_time";

  return (
    <main className="ms-experience ms-experience--match" id="main-content">
      <header className="ms-experience__masthead">
        <button onClick={onBack} type="button">
          Leave Experience
        </button>
        <span>EXPERIENCE · SIMULATED TXLINE-SHAPED DATA</span>
      </header>
      {catchupCount > 0 ? (
        <aside className="ms-experience-catchup" role="status">
          <b>Caught you up</b>
          <span>{catchupCount} things happened while the stream was away.</span>
        </aside>
      ) : null}
      {streamPaused ? (
        <aside className="ms-experience-reconnect" role="status">
          <b>Testing reconnect</b>
          <span>
            The server match keeps moving. MatchSense will reconcile the two
            missed events in order before returning live.
          </span>
        </aside>
      ) : null}
      <section
        className="ms-experience-score"
        aria-label={`${home.name} versus ${away.name}`}
      >
        <div className="ms-experience-score__status">
          <i aria-hidden="true" />
          <span>
            {isFinal
              ? "FINAL"
              : countdown > 0
                ? `KICKOFF IN ${countdown}`
                : "EXPERIENCE LIVE"}
          </span>
          <small>SERVER RUN · {run.nextBeatIndex}/20</small>
        </div>
        <div className="ms-experience-score__teams">
          <div>
            <TeamFlag size="hero" team={home} />
            <b>{home.name}</b>
          </div>
          <strong>
            <span>{score.home}</span>
            <i>—</i>
            <span>{score.away}</span>
            <small>{fixture.minute}</small>
          </strong>
          <div>
            <TeamFlag size="hero" team={away} />
            <b>{away.name}</b>
          </div>
        </div>
        <p>
          {lastTranscript?.text ??
            lastMoment?.detail ??
            (lastMoment
              ? eventLabel(lastMoment)
              : "The server is holding the next canonical match beat.")}
        </p>
      </section>
      <div className="ms-experience-match-grid">
        {!memoryOpen ? (
          <ListeningControl
            fixtureId={fixture.fixtureId}
            moment={listeningMoment}
            perspectiveTeam={perspective}
            terminal={isFinal}
          />
        ) : null}
        <section className="ms-experience-truth-rail">
          <header>
            <p>TRUTH RAIL</p>
            <h2>What changed</h2>
          </header>
          {eventRail.length ? (
            eventRail.map((event) => (
              <article data-kind={event.kind} key={event.identity}>
                <time>{event.minute}</time>
                <span>
                  <b>{eventLabel(event)}</b>
                  <small>
                    {event.status} · revision {event.revision}
                  </small>
                </span>
              </article>
            ))
          ) : (
            <p className="ms-experience-empty">
              Kickoff is the first server beat.
            </p>
          )}
        </section>
      </div>
      {isFinal ? (
        <section className="ms-experience-finish">
          <p>MATCH MEMORY READY</p>
          <h2>
            Your five-minute night: three goals, five cards and two honest VAR
            decisions.
          </h2>
          <span>
            The final record keeps every revision; the apparent equalizer is
            shown as overturned, never erased.
          </span>
          <button onClick={() => setMemoryOpen(true)} type="button">
            Open Match Memory
          </button>
        </section>
      ) : null}
      {moment ? (
        <ExperienceMoment
          authoredCaption={
            transcripts.find(
              (entry) => entry.momentIdentity === moment.identity,
            )?.text ?? null
          }
          catalog={catalog}
          moment={moment}
          onClose={onCloseMoment}
          snapshot={fixture}
        />
      ) : null}
      {memoryOpen ? (
        <ExperienceMemory
          catalog={catalog}
          fixture={fixture}
          onClose={() => setMemoryOpen(false)}
          onRestart={onRestart}
          timeline={revisionHistory}
          transcripts={transcripts}
        />
      ) : null}
    </main>
  );
}
