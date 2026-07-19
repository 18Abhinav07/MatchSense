import { useEffect, useMemo, useReducer, useRef, useState } from "react";

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

export type ExperienceMemoryReplayPhase =
  "complete" | "idle" | "loading" | "paused" | "playing" | "unavailable";

export interface ExperienceMemoryReplayState {
  index: number | null;
  phase: ExperienceMemoryReplayPhase;
  segment: "intro" | "moment" | null;
  total: number;
}

export type ExperienceMemoryReplayAction =
  | { type: "audio_ended" }
  | { type: "audio_started" }
  | { type: "audio_unavailable" }
  | { type: "close" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "retry" }
  | { type: "skip" }
  | { type: "start" };

export function createExperienceMemoryReplayState(
  total: number,
): ExperienceMemoryReplayState {
  return {
    index: null,
    phase: "idle",
    segment: null,
    total: Math.max(0, total),
  };
}

export function experienceMemoryReplayIsActive(
  state: ExperienceMemoryReplayState,
) {
  return state.phase !== "idle" && state.phase !== "complete";
}

function nextMoment(
  state: ExperienceMemoryReplayState,
): ExperienceMemoryReplayState {
  if (state.segment === "intro") {
    return state.total > 0
      ? { ...state, index: 0, phase: "loading", segment: "moment" }
      : { ...state, index: null, phase: "complete", segment: null };
  }
  if (
    state.segment === "moment" &&
    state.index !== null &&
    state.index < state.total - 1
  ) {
    return { ...state, index: state.index + 1, phase: "loading" };
  }
  return { ...state, index: null, phase: "complete", segment: null };
}

export function experienceMemoryReplayReducer(
  state: ExperienceMemoryReplayState,
  action: ExperienceMemoryReplayAction,
): ExperienceMemoryReplayState {
  if (action.type === "close") {
    return { ...state, index: null, phase: "idle", segment: null };
  }
  if (action.type === "start") {
    if (state.total === 0) return state;
    return { ...state, index: null, phase: "loading", segment: "intro" };
  }
  if (action.type === "audio_started") {
    return state.phase === "loading" ? { ...state, phase: "playing" } : state;
  }
  if (action.type === "audio_unavailable") {
    return state.phase === "loading" ||
      state.phase === "paused" ||
      state.phase === "playing"
      ? { ...state, phase: "unavailable" }
      : state;
  }
  if (action.type === "pause") {
    return state.phase === "playing" ? { ...state, phase: "paused" } : state;
  }
  if (action.type === "resume") {
    return state.phase === "paused" ? { ...state, phase: "playing" } : state;
  }
  if (action.type === "retry") {
    return state.phase === "unavailable"
      ? { ...state, phase: "loading" }
      : state;
  }
  if (action.type === "skip") {
    return state.phase === "unavailable" || state.phase === "loading"
      ? nextMoment(state)
      : state;
  }
  return state.phase === "playing" ? nextMoment(state) : state;
}

function experienceRunId(fixtureId: string) {
  const prefix = "experience:";
  if (!fixtureId.startsWith(prefix) || fixtureId.length === prefix.length) {
    throw new Error("Experience replay requires an Experience fixture id");
  }
  return fixtureId.slice(prefix.length);
}

export function experienceMemoryIntroPath(fixtureId: string) {
  return `/api/v1/experience/runs/${encodeURIComponent(experienceRunId(fixtureId))}/memory/intro.mp3`;
}

export function experienceMemoryArtifactPath(
  fixtureId: string,
  identity: string,
) {
  return `/api/v1/experience/runs/${encodeURIComponent(experienceRunId(fixtureId))}/moments/${encodeURIComponent(identity)}/audio`;
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
  const [replay, dispatchReplay] = useReducer(
    experienceMemoryReplayReducer,
    replayMoments.length,
    createExperienceMemoryReplayState,
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackTokenRef = useRef(0);
  const replayMoment =
    replay.segment !== "moment" || replay.index === null
      ? null
      : (replayMoments[replay.index] ?? null);
  const replayTitle = replayMoment
    ? eventLabel(replayMoment)
    : "Saved match Moment";
  const home =
    catalog.teams.find((team) => team.code === fixture.homeTeam) ??
    fallbackTeam(fixture.homeTeam);
  const away =
    catalog.teams.find((team) => team.code === fixture.awayTeam) ??
    fallbackTeam(fixture.awayTeam);
  const score = fixture.score ?? { away: 1, home: 2 };

  const releaseReplayAudio = () => {
    playbackTokenRef.current += 1;
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };

  useEffect(() => () => releaseReplayAudio(), []);

  const playAudio = (url: string) => {
    const audio = audioRef.current;
    if (!audio) {
      dispatchReplay({ type: "audio_unavailable" });
      return;
    }
    const token = ++playbackTokenRef.current;
    audio.src = url;
    audio.load();
    void audio.play().then(
      () => {
        if (playbackTokenRef.current === token) {
          dispatchReplay({ type: "audio_started" });
        }
      },
      () => {
        if (playbackTokenRef.current === token) {
          dispatchReplay({ type: "audio_unavailable" });
        }
      },
    );
  };

  const beginReplay = () => {
    dispatchReplay({ type: "start" });
    playAudio(experienceMemoryIntroPath(fixture.fixtureId));
  };

  const nextAudioUrl = (
    segment: ExperienceMemoryReplayState["segment"],
    index: number | null,
  ) => {
    if (segment === "intro") {
      const first = replayMoments[0];
      return first
        ? experienceMemoryArtifactPath(fixture.fixtureId, first.identity)
        : null;
    }
    if (segment === "moment" && index !== null) {
      const next = replayMoments[index + 1];
      return next
        ? experienceMemoryArtifactPath(fixture.fixtureId, next.identity)
        : null;
    }
    return null;
  };

  const handleAudioEnded = () => {
    const url = nextAudioUrl(replay.segment, replay.index);
    dispatchReplay({ type: "audio_ended" });
    if (url) playAudio(url);
  };

  const closeReplay = () => {
    releaseReplayAudio();
    dispatchReplay({ type: "close" });
  };

  const retryReplayAudio = () => {
    const url =
      replay.segment === "intro"
        ? experienceMemoryIntroPath(fixture.fixtureId)
        : replayMoment
          ? experienceMemoryArtifactPath(
              fixture.fixtureId,
              replayMoment.identity,
            )
          : null;
    if (!url) return;
    dispatchReplay({ type: "retry" });
    playAudio(url);
  };

  const skipUnavailableAudio = () => {
    const url = nextAudioUrl(replay.segment, replay.index);
    dispatchReplay({ type: "skip" });
    if (url) playAudio(url);
  };

  const toggleReplayAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (replay.phase === "playing") {
      audio.pause();
      dispatchReplay({ type: "pause" });
      return;
    }
    if (replay.phase !== "paused") return;
    const token = ++playbackTokenRef.current;
    void audio.play().then(
      () => {
        if (playbackTokenRef.current === token) {
          dispatchReplay({ type: "resume" });
        }
      },
      () => {
        if (playbackTokenRef.current === token) {
          dispatchReplay({ type: "audio_unavailable" });
        }
      },
    );
  };

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
        <button
          onClick={() => {
            closeReplay();
            onClose();
          }}
          type="button"
        >
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
                <b>{eventLabel(moment)}</b>
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
          disabled={
            !replayMoments.length || experienceMemoryReplayIsActive(replay)
          }
          onClick={beginReplay}
          type="button"
        >
          {replay.phase === "complete"
            ? "Replay audio summary again"
            : "Replay key Moments with audio"}
        </button>
        <button onClick={() => void share()} type="button">
          Share this Memory
        </button>
        <button
          onClick={() => {
            closeReplay();
            onRestart();
          }}
          type="button"
        >
          Start a new Experience
        </button>
        <small>Here is your MatchSense match summary.</small>
        {notice ? <span role="status">{notice}</span> : null}
      </footer>
      <audio
        aria-hidden="true"
        onEnded={handleAudioEnded}
        onError={() => dispatchReplay({ type: "audio_unavailable" })}
        preload="auto"
        ref={audioRef}
      />
      {replayMoment ? (
        <ExperienceMoment
          catalog={catalog}
          moment={replayMoment}
          onClose={closeReplay}
          snapshot={{ ...fixture, score: replayMoment.score }}
        />
      ) : null}
      {replay.phase !== "idle" && replay.phase !== "complete" ? (
        <section
          aria-live="polite"
          className="ms-experience-memory__replay-audio"
          data-phase={replay.phase}
        >
          <div>
            <small>
              {replay.segment === "intro"
                ? "MATCH MEMORY · INTRO"
                : `MOMENT ${(replay.index ?? 0) + 1} OF ${replay.total}`}
            </small>
            <strong>
              {replay.segment === "intro"
                ? "Here is your MatchSense match summary."
                : replayTitle}
            </strong>
            <span>
              {replay.phase === "unavailable"
                ? "This saved commentary audio is not available yet. Nothing was skipped automatically."
                : replay.phase === "loading"
                  ? "Loading the saved MatchSense commentary…"
                  : replay.phase === "paused"
                    ? "Audio paused. This Moment will stay on screen."
                    : "The next Moment appears only after this audio finishes."}
            </span>
          </div>
          <nav aria-label="Match summary audio controls">
            {replay.phase === "unavailable" ? (
              <>
                <button onClick={retryReplayAudio} type="button">
                  Try audio again
                </button>
                <button onClick={skipUnavailableAudio} type="button">
                  {replay.segment === "intro"
                    ? "Continue without intro"
                    : "Skip this Moment"}
                </button>
              </>
            ) : replay.phase === "playing" || replay.phase === "paused" ? (
              <button onClick={toggleReplayAudio} type="button">
                {replay.phase === "playing" ? "Pause audio" : "Resume audio"}
              </button>
            ) : null}
            <button onClick={closeReplay} type="button">
              Close replay
            </button>
          </nav>
        </section>
      ) : null}
    </div>
  );
}
