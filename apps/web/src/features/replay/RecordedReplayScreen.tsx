import { TeamFlag } from "../../components/TeamFlag.js";
import {
  eventLabel,
  fallbackTeam,
  type ProductCatalog,
  type ProductTeam,
} from "../../live-api.js";
import type { RecordedReplayTimeline } from "../../replay-api.js";

import "./recorded-replay.css";

export interface RecordedReplayScreenProps {
  catalog: ProductCatalog;
  onBack?: (() => void) | undefined;
  replay: RecordedReplayTimeline;
}

function teamFor(catalog: ProductCatalog, code: string): ProductTeam {
  return catalog.teams.find((team) => team.code === code) ?? fallbackTeam(code);
}

export function RecordedReplayScreen({
  catalog,
  onBack,
  replay,
}: RecordedReplayScreenProps) {
  const snapshot = replay.snapshot;
  const home = teamFor(catalog, snapshot.homeTeam);
  const away = teamFor(catalog, snapshot.awayTeam);
  const score = snapshot.score;
  const moments = replay.events.flatMap((event) =>
    event.moment ? [{ event, moment: event.moment }] : [],
  );
  const sourceOnlyCount = replay.events.length - moments.length;

  return (
    <main className="ms-recorded-screen" id="main-content">
      <header className="ms-recorded-screen__header">
        {onBack ? (
          <button onClick={onBack} type="button">
            Back to replays
          </button>
        ) : (
          <span>MatchSense</span>
        )}
        <span>RECORDED · TXLINE DATA</span>
      </header>

      <section
        className="ms-recorded-screen__result"
        aria-label="Recorded final result"
      >
        <p>AUTHORISED ARCHIVE · FINAL FACT</p>
        <div>
          <TeamFlag size="hero" team={home} />
          <strong>
            <span>{score.home}</span>
            <i>—</i>
            <span>{score.away}</span>
            <small>Full time</small>
          </strong>
          <TeamFlag size="hero" team={away} />
        </div>
        <b>
          {home.name} {score.home}—{score.away} {away.name}
        </b>
      </section>

      <section
        className="ms-recorded-screen__timeline"
        aria-labelledby="replay-timeline-title"
      >
        <header>
          <div>
            <p>ORDERED CANONICAL EVENTS</p>
            <h1 id="replay-timeline-title">Recorded match flow</h1>
          </div>
          <span>Replay sequence {replay.highWaterSequence}</span>
        </header>
        {moments.length ? (
          <ol>
            {moments.map(({ event, moment }) => (
              <li
                data-replay-sequence={event.replaySeq}
                key={`${event.replaySeq}:${event.eventId}`}
              >
                <time>{moment.minute}</time>
                <div>
                  <strong>{eventLabel(moment)}</strong>
                  <span>
                    {moment.detail ??
                      "Canonical event in the authorised archive."}
                  </span>
                </div>
                <small>SEQ {event.replaySeq}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ms-recorded-screen__empty">
            No presentable canonical Moments were published for this recorded
            match.
          </p>
        )}
        {sourceOnlyCount ? (
          <p className="ms-recorded-screen__source-only">
            {sourceOnlyCount} source record{sourceOnlyCount === 1 ? "" : "s"}{" "}
            remained in the archive without being presented as a fan Moment.
          </p>
        ) : null}
      </section>
    </main>
  );
}
