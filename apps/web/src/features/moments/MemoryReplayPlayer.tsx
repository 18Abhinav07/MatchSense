import { type CSSProperties, useEffect, useReducer, useState } from "react";

import { TeamFlag } from "../../components/TeamFlag.js";
import type { MomentScore, MomentTeam } from "./types.js";

export interface MemoryReplayMoment {
  detail?: string | undefined;
  identity: string;
  kind: string;
  minute: string;
  score: { away: number; home: number };
  team?: MomentTeam | undefined;
  title: string;
}

export type MemoryReplayPhase = "complete" | "paused" | "playing" | "ready";

export interface MemoryReplayState {
  index: number;
  phase: MemoryReplayPhase;
  total: number;
}

export type MemoryReplayAction =
  | { type: "advance" }
  | { type: "pause" }
  | { type: "play" }
  | { type: "restart" };

export const MEMORY_REPLAY_DELAYS_MS = Object.freeze({
  intro: 900,
  moment: 4_200,
});

export function memoryReplayPath(fixtureId: string) {
  return `/matches/${encodeURIComponent(fixtureId)}/memory/replay`;
}

export function createMemoryReplayState(total: number): MemoryReplayState {
  return { index: -1, phase: "ready", total: Math.max(0, total) };
}

export function memoryReplayReducer(
  state: MemoryReplayState,
  action: MemoryReplayAction,
): MemoryReplayState {
  if (action.type === "pause") {
    return state.phase === "playing" ? { ...state, phase: "paused" } : state;
  }
  if (action.type === "play") {
    if (state.total === 0) return state;
    return state.phase === "complete"
      ? { ...state, index: -1, phase: "playing" }
      : { ...state, phase: "playing" };
  }
  if (action.type === "restart") {
    return {
      ...state,
      index: -1,
      phase: state.total > 0 ? "playing" : "ready",
    };
  }
  if (state.phase !== "playing" || state.total === 0) return state;
  if (state.index < state.total - 1) {
    return { ...state, index: state.index + 1 };
  }
  return { ...state, phase: "complete" };
}

export function memoryReplaySpeechText(
  moment: MemoryReplayMoment,
  homeTeam: MomentTeam,
  awayTeam: MomentTeam,
) {
  return `${moment.minute}. ${moment.title}. ${homeTeam.name} ${moment.score.home}, ${awayTeam.name} ${moment.score.away}.`;
}

function replayControlLabel(phase: MemoryReplayPhase) {
  if (phase === "playing") return "Pause replay";
  if (phase === "paused") return "Resume replay";
  if (phase === "complete") return "Play again";
  return "Play canonical replay";
}

function eventCode(kind: string) {
  if (kind.includes("goal")) return "GOAL";
  if (kind.includes("var")) return "VAR";
  if (kind.includes("red")) return "RED";
  if (kind.includes("yellow")) return "CARD";
  if (kind.includes("half")) return "HT";
  if (kind.includes("full")) return "FT";
  return "TURN";
}

function stopBrowserSpeech() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

export function MemoryReplayPlayer({
  finalScore,
  moments,
  onBack,
  onOpenMemory,
  sourceLabel,
  summary,
  supportedTeam,
}: {
  finalScore: MomentScore;
  moments: readonly MemoryReplayMoment[];
  onBack(): void;
  onOpenMemory(): void;
  sourceLabel: string;
  summary: string;
  supportedTeam: MomentTeam;
}) {
  const [state, dispatch] = useReducer(
    memoryReplayReducer,
    moments.length,
    createMemoryReplayState,
  );
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const current =
    state.phase !== "complete" && state.index >= 0
      ? moments[state.index]
      : undefined;
  const theme = current?.team ?? supportedTeam;
  const speechAvailable =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window;
  const progress =
    state.total === 0
      ? 0
      : state.phase === "complete"
        ? 100
        : Math.max(0, ((state.index + 1) / state.total) * 100);

  useEffect(() => {
    if (state.phase !== "playing") return;
    const timer = window.setTimeout(
      () => dispatch({ type: "advance" }),
      state.index < 0
        ? MEMORY_REPLAY_DELAYS_MS.intro
        : MEMORY_REPLAY_DELAYS_MS.moment,
    );
    return () => window.clearTimeout(timer);
  }, [state.index, state.phase]);

  useEffect(() => {
    if (!voiceEnabled || state.phase !== "playing" || !current) {
      stopBrowserSpeech();
      return;
    }
    if (!speechAvailable) return;
    const utterance = new window.SpeechSynthesisUtterance(
      memoryReplaySpeechText(current, finalScore.homeTeam, finalScore.awayTeam),
    );
    utterance.lang = "en-GB";
    utterance.rate = 0.96;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [
    current,
    finalScore.awayTeam,
    finalScore.homeTeam,
    speechAvailable,
    state.phase,
    voiceEnabled,
  ]);

  useEffect(() => () => stopBrowserSpeech(), []);

  const togglePlayback = () => {
    dispatch({ type: state.phase === "playing" ? "pause" : "play" });
  };

  return (
    <article
      className="memory-replay"
      data-replay-phase={state.phase}
      data-state="memory-replay"
      style={
        {
          "--memory-primary": theme.primary,
          "--memory-secondary": theme.secondary,
          "--memory-foreground": theme.foreground ?? "#f7f4ea",
        } as CSSProperties
      }
    >
      <header className="memory-replay__header">
        <button className="memory-replay__back" onClick={onBack} type="button">
          Back to history
        </button>
        <span>{sourceLabel} · persisted canonical Moments</span>
        <button onClick={onOpenMemory} type="button">
          Open full memory
        </button>
      </header>

      <section className="memory-replay__score" aria-label="Final score">
        <p>Final truth · score first</p>
        <div>
          <span>
            <TeamFlag size="standard" team={finalScore.homeTeam} />
            <b>{finalScore.homeTeam.code}</b>
            <small>{finalScore.homeTeam.name}</small>
          </span>
          <strong>
            {finalScore.home}—{finalScore.away}
          </strong>
          <span>
            <TeamFlag size="standard" team={finalScore.awayTeam} />
            <b>{finalScore.awayTeam.code}</b>
            <small>{finalScore.awayTeam.name}</small>
          </span>
        </div>
      </section>

      <section
        aria-live="polite"
        className="memory-replay__stage"
        data-event-kind={current?.kind ?? "intro"}
      >
        {current ? (
          <div className="memory-replay__moment" key={current.identity}>
            <div className="memory-replay__moment-mark">
              <span>{current.minute}</span>
              <b>{eventCode(current.kind)}</b>
            </div>
            <div className="memory-replay__moment-copy">
              <p>
                Moment {state.index + 1} of {state.total}
              </p>
              <h1>{current.title}</h1>
              {current.detail ? (
                <blockquote>{current.detail}</blockquote>
              ) : null}
              <div>
                <span>After this Moment</span>
                <strong>
                  {finalScore.homeTeam.code} {current.score.home}—
                  {current.score.away} {finalScore.awayTeam.code}
                </strong>
              </div>
            </div>
            {current.team ? (
              <TeamFlag
                className="memory-replay__event-flag"
                size="hero"
                team={current.team}
              />
            ) : null}
          </div>
        ) : state.phase === "complete" ? (
          <div className="memory-replay__intro memory-replay__intro--complete">
            <p>Replay complete</p>
            <h1>The final truth remains the final truth.</h1>
            <span>{summary}</span>
          </div>
        ) : (
          <div className="memory-replay__intro">
            <p>Canonical replay ready</p>
            <h1>{summary}</h1>
            <span>
              The verified result is already on screen. Press play to step
              through {moments.length} saved Moment
              {moments.length === 1 ? "" : "s"} in order.
            </span>
          </div>
        )}
      </section>

      <div className="memory-replay__progress">
        <span>
          {state.phase === "complete"
            ? "Replay complete"
            : state.index < 0
              ? "Final score painted"
              : `${state.index + 1} / ${state.total}`}
        </span>
        <div
          aria-label="Replay progress"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(progress)}
          role="progressbar"
        >
          <i style={{ width: `${progress}%` }} />
        </div>
      </div>

      <footer className="memory-replay__controls">
        <div>
          <button
            className="memory-replay__play"
            disabled={!moments.length}
            onClick={togglePlayback}
            type="button"
          >
            {replayControlLabel(state.phase)}
          </button>
          <button
            disabled={!moments.length}
            onClick={() => dispatch({ type: "restart" })}
            type="button"
          >
            Restart
          </button>
        </div>
        <div className="memory-replay__voice">
          <button
            aria-pressed={voiceEnabled}
            disabled={!speechAvailable}
            onClick={() => setVoiceEnabled((enabled) => !enabled)}
            type="button"
          >
            Foreground voice recap · {voiceEnabled ? "On" : "Off"}
          </button>
          <small>
            Browser speech plays only while this replay screen is open. It is
            separate from live Listening Mode and does not continue in the
            background.
          </small>
        </div>
      </footer>

      <ol
        className="memory-replay__timeline"
        aria-label="Canonical replay order"
      >
        {moments.map((moment, index) => (
          <li
            data-active={state.phase !== "complete" && index === state.index}
            data-passed={state.phase === "complete" || index < state.index}
            key={moment.identity}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <b>{moment.minute}</b>
            <small>{moment.title}</small>
          </li>
        ))}
      </ol>
    </article>
  );
}
