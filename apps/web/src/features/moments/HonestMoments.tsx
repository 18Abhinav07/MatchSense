import { type CSSProperties, useId } from "react";

import "./honest-moments.css";

import type {
  CatchUpEvent,
  ConfirmedGoalMomentProps,
  FreshnessBannerProps,
  MatchMemoryProps,
  MomentScore,
  MomentTeam,
  MomentTruth,
  ReconnectCatchUpProps,
  VarDecisionMomentProps,
  VarOverturnedMomentProps,
  VarReviewMomentProps,
} from "./types.js";

function teamStyle(team: MomentTeam): CSSProperties {
  return {
    "--msm-team": team.primary,
    "--msm-team-ink": team.foreground ?? "#f4f1e8",
    "--msm-team-secondary": team.secondary,
  } as CSSProperties;
}

function TeamMark({
  team,
  quiet = false,
}: {
  team: MomentTeam;
  quiet?: boolean;
}) {
  return (
    <span
      aria-label={`${team.name} team mark`}
      className={`msm-team-mark${quiet ? " msm-team-mark--quiet" : ""}`}
      role="img"
      style={teamStyle(team)}
    >
      <i aria-hidden="true" />
      <b>{team.code}</b>
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M19 8a8 8 0 1 0 1 7" />
      <path d="M19 3v5h-5" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8.2 10.8 7.5-4.4M8.2 13.2l7.5 4.4" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 8a9 9 0 1 1-1 7" />
      <path d="M4 3v5h5" />
      <path d="m10 9 5 3-5 3Z" />
    </svg>
  );
}

function StatusIcon({ kind }: { kind: "review" | "stands" | "overturned" }) {
  if (kind === "stands") {
    return (
      <svg aria-hidden="true" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="19" />
        <path d="m15 24 6 6 13-14" />
      </svg>
    );
  }
  if (kind === "overturned") {
    return (
      <svg aria-hidden="true" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="19" />
        <path d="m17 17 14 14M31 17 17 31" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48">
      <path d="M10 12h28v20H10z" />
      <path d="M16 37h16M24 32v5M17 21h14" />
      <circle cx="24" cy="21" r="4" />
    </svg>
  );
}

function scoreLabel(score: MomentScore) {
  return `${score.homeTeam.code} ${score.home}—${score.away} ${score.awayTeam.code}`;
}

function TruthRail({
  label,
  score,
  truth,
  tone = "confirmed",
}: {
  label: string;
  score: MomentScore;
  truth: MomentTruth;
  tone?: "confirmed" | "review" | "revised" | "final";
}) {
  return (
    <header className="msm-truth-rail" data-tone={tone}>
      <span className="msm-truth-state">
        <i aria-hidden="true" />
        {label}
      </span>
      <b
        aria-label={`${score.homeTeam.name} ${score.home}, ${score.awayTeam.name} ${score.away}`}
      >
        {scoreLabel(score)}
      </b>
      <span className="msm-truth-meta">
        {truth.minute} · revision {truth.revision}
      </span>
    </header>
  );
}

function SourceStamp({ truth }: { truth: MomentTruth }) {
  return (
    <footer className="msm-source-stamp">
      <span>{truth.sourceLabel ?? "CANONICAL MATCH DATA"}</span>
      <span>{truth.eventId}</span>
    </footer>
  );
}

function ScoreLockup({ score }: { score: MomentScore }) {
  return (
    <div className="msm-score-lockup" aria-label={scoreLabel(score)}>
      <span>
        <small>{score.homeTeam.code}</small>
        <b>{score.home}</b>
      </span>
      <i aria-hidden="true" />
      <span>
        <small>{score.awayTeam.code}</small>
        <b>{score.away}</b>
      </span>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  quiet = false,
}: {
  children: React.ReactNode;
  onClick(): void;
  quiet?: boolean;
}) {
  return (
    <button
      className={`msm-action${quiet ? " msm-action--quiet" : ""}`}
      onClick={onClick}
      type="button"
    >
      <span>{children}</span>
      <i aria-hidden="true">
        <ArrowIcon />
      </i>
    </button>
  );
}

export function ConfirmedGoalMoment({
  scoringTeam,
  score,
  truth,
  relation = "neutral",
  playerName,
  assistName,
  headline,
  consequence,
  commentary,
  sponsor,
  onClose,
  closeLabel = "Return to match",
}: ConfirmedGoalMomentProps) {
  const titleId = useId();
  const descriptionId = useId();
  const defaultHeadline = playerName
    ? `${playerName} changes the match.`
    : `${scoringTeam.name} change the match.`;

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="msm-moment msm-goal"
      data-relation={relation}
      data-state="confirmed-goal"
      role="dialog"
      style={teamStyle(scoringTeam)}
    >
      <TruthRail label="Goal · confirmed" score={score} truth={truth} />
      <div className="msm-goal-field" aria-hidden="true">
        <div className="msm-pitch-lines" />
        <div className="msm-goal-ribbons">
          <i />
          <i />
          <i />
          <i />
        </div>
        <span>GOAL</span>
      </div>
      <div className="msm-goal-story">
        <div className="msm-goal-team">
          <TeamMark team={scoringTeam} />
          <span>
            <small>{scoringTeam.code} · confirmed scorer</small>
            <b>{playerName ?? scoringTeam.name}</b>
            {assistName ? <em>Assist · {assistName}</em> : null}
          </span>
        </div>
        <p className="msm-eyebrow">Current canonical moment</p>
        <h2 id={titleId}>{headline ?? defaultHeadline}</h2>
        <p className="msm-consequence" id={descriptionId}>
          {consequence ??
            "The score was current before this celebration opened."}
        </p>
        {commentary ? (
          <blockquote className="msm-commentary">{commentary}</blockquote>
        ) : null}
        <ScoreLockup score={score} />
      </div>
      <div className="msm-moment-actions">
        {sponsor && relation === "for" ? (
          <span className="msm-sponsor">Moment presented by {sponsor}</span>
        ) : (
          <span />
        )}
        <ActionButton onClick={onClose}>{closeLabel}</ActionButton>
      </div>
      <SourceStamp truth={truth} />
    </section>
  );
}

function DecisionMoment({
  kind,
  team,
  score,
  truth,
  subject,
  headline,
  detail,
  onContinue,
  supersededScore,
  reason,
}: VarDecisionMomentProps & {
  kind: "stands" | "overturned";
  supersededScore?: Pick<MomentScore, "home" | "away">;
  reason?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const isStands = kind === "stands";

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="msm-moment msm-decision"
      data-state={`var-${kind}`}
      role="dialog"
      style={teamStyle(team)}
    >
      <TruthRail
        label={isStands ? "VAR · decision stands" : "VAR · overturned"}
        score={score}
        truth={truth}
        tone={isStands ? "confirmed" : "revised"}
      />
      <div className="msm-decision-grid">
        <div className="msm-decision-signal" aria-hidden="true">
          <StatusIcon kind={kind} />
          <span>{isStands ? "STANDS" : "NO GOAL"}</span>
        </div>
        <div className="msm-decision-copy">
          <p className="msm-eyebrow">{subject ?? "Video review complete"}</p>
          <h2 id={titleId}>
            {headline ??
              (isStands ? "The goal stands." : "The goal is overturned.")}
          </h2>
          <p id={descriptionId}>
            {detail ??
              (isStands
                ? "The canonical score is confirmed. Celebration can continue."
                : "The score has rolled back cleanly. No celebration or reaction was sent.")}
          </p>
          {!isStands && supersededScore ? (
            <div className="msm-score-revision" aria-label="Score revision">
              <span>
                Superseded
                <s>
                  {supersededScore.home}—{supersededScore.away}
                </s>
              </span>
              <i aria-hidden="true">
                <ArrowIcon />
              </i>
              <span>
                Current
                <b>
                  {score.home}—{score.away}
                </b>
              </span>
            </div>
          ) : null}
          {!isStands && reason ? (
            <p className="msm-reason">Decision · {reason}</p>
          ) : null}
          <ActionButton onClick={onContinue}>
            {isStands ? "Continue celebration" : "Return to current score"}
          </ActionButton>
        </div>
      </div>
      <SourceStamp truth={truth} />
    </section>
  );
}

export function VarUnderReviewMoment({
  attackingTeam,
  score,
  truth,
  subject = "Possible goal",
  detail = "Video review is checking the decision. Celebration, sponsorship, and rival reactions are held.",
  onReturn,
}: VarReviewMomentProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="msm-moment msm-review"
      data-state="var-under-review"
      role="dialog"
      style={teamStyle(attackingTeam)}
    >
      <TruthRail
        label="VAR · under review"
        score={score}
        truth={truth}
        tone="review"
      />
      <div className="msm-review-stage">
        <div className="msm-review-monitor" aria-hidden="true">
          <i />
          <StatusIcon kind="review" />
          <span>CHECKING</span>
        </div>
        <div className="msm-review-copy">
          <TeamMark quiet team={attackingTeam} />
          <p className="msm-eyebrow">
            {subject} · {truth.minute}
          </p>
          <h2 id={titleId}>Hold the roar.</h2>
          <p id={descriptionId}>{detail}</p>
          <div className="msm-held-actions" aria-label="Actions currently held">
            <span>Celebration held</span>
            <span>Sponsor held</span>
            <span>Reactions held</span>
          </div>
          {onReturn ? (
            <button
              className="msm-text-action"
              onClick={onReturn}
              type="button"
            >
              Keep following the match <ArrowIcon />
            </button>
          ) : null}
        </div>
      </div>
      <SourceStamp truth={truth} />
    </section>
  );
}

export function VarStandsMoment(props: VarDecisionMomentProps) {
  return <DecisionMoment {...props} kind="stands" />;
}

export function VarOverturnedMoment({
  supersededScore,
  reason,
  ...props
}: VarOverturnedMomentProps) {
  return (
    <DecisionMoment
      {...props}
      kind="overturned"
      {...(reason === undefined ? {} : { reason })}
      {...(supersededScore === undefined ? {} : { supersededScore })}
    />
  );
}

const eventLabels: Record<CatchUpEvent["kind"], string> = {
  full_time: "Full time",
  goal: "Goal",
  half_time: "Half time",
  other: "Match update",
  red_card: "Red card",
  var: "VAR",
  yellow_card: "Yellow card",
};

export function ReconnectCatchUp({
  events,
  sourceLabel,
  caughtUpAt,
  onContinue,
}: ReconnectCatchUpProps) {
  const titleId = useId();
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  return (
    <section
      aria-labelledby={titleId}
      aria-modal="true"
      className="msm-catchup"
      data-state="reconnect-catch-up"
      role="dialog"
    >
      <header className="msm-catchup-head">
        <span className="msm-reconnected">
          <i aria-hidden="true" /> Reconnected
        </span>
        <p className="msm-eyebrow">Nothing silently skipped</p>
        <h2 id={titleId}>
          Caught you up — {ordered.length}{" "}
          {ordered.length === 1 ? "thing" : "things"} happened.
        </h2>
        <p>
          Missed events are replayed in canonical order. Then you return to now.
        </p>
      </header>
      {ordered.length ? (
        <ol className="msm-catchup-wire" aria-label="Missed events in order">
          {ordered.map((event, index) => (
            <li
              data-overturned={event.overturned ? "true" : "false"}
              key={`${event.id}:${event.revision}`}
              style={{ "--msm-order": index } as CSSProperties}
            >
              <span className="msm-wire-order">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="msm-wire-minute">{event.minute}</span>
              {event.team ? (
                <TeamMark quiet team={event.team} />
              ) : (
                <i className="msm-wire-neutral" />
              )}
              <span className="msm-wire-copy">
                <small>
                  {eventLabels[event.kind]} · revision {event.revision}
                </small>
                <b>{event.title}</b>
                {event.detail ? <em>{event.detail}</em> : null}
              </span>
              {event.overturned ? <strong>Overturned</strong> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="msm-catchup-empty">
          The wire reconciled cleanly. No match events were missed.
        </p>
      )}
      <footer className="msm-catchup-foot">
        <span>
          {sourceLabel} · caught up {caughtUpAt}
        </span>
        <ActionButton onClick={onContinue}>Go to live match</ActionButton>
      </footer>
    </section>
  );
}

export function FreshnessBanner({
  status,
  asOf,
  age,
  message,
  onRetry,
}: FreshnessBannerProps) {
  const isOffline = status === "offline";
  return (
    <aside
      aria-atomic="true"
      className="msm-freshness"
      data-state={status}
      role={isOffline ? "alert" : "status"}
    >
      <span className="msm-freshness-signal" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="msm-freshness-copy">
        <small>
          {isOffline
            ? "Offline · current score cached"
            : "Connection interrupted · showing cached score"}
        </small>
        <b>
          As of {asOf} · {age}
        </b>
        <em>
          {message ??
            "Motion, audio, sponsorship, and reactions are paused until fresh truth returns."}
        </em>
      </span>
      {onRetry ? (
        <button onClick={onRetry} type="button">
          <RefreshIcon /> Retry now
        </button>
      ) : null}
    </aside>
  );
}

function ordinal(value: number) {
  const suffix = value % 100;
  if (suffix >= 11 && suffix <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

export function MatchMemory({
  supportedTeam,
  score,
  truth,
  summary,
  moments,
  roomResult,
  stats = [],
  onShare,
  onReplay,
}: MatchMemoryProps) {
  const titleId = useId();

  return (
    <article
      aria-labelledby={titleId}
      className="msm-memory"
      data-state="match-memory"
      style={teamStyle(supportedTeam)}
    >
      <TruthRail
        label="Full time · finalised"
        score={score}
        truth={truth}
        tone="final"
      />
      <div className="msm-memory-hero">
        <div className="msm-memory-ticket" aria-hidden="true">
          <span>Match</span>
          <span>Memory</span>
          <i />
        </div>
        <div className="msm-memory-intro">
          <p className="msm-eyebrow">Your match · {supportedTeam.code}</p>
          <h2 id={titleId}>{summary}</h2>
          <div className="msm-memory-score">
            <TeamMark team={score.homeTeam} />
            <b>{score.home}</b>
            <i>—</i>
            <b>{score.away}</b>
            <TeamMark team={score.awayTeam} />
          </div>
        </div>
      </div>
      <div className="msm-memory-body">
        <section
          className="msm-memory-moments"
          aria-labelledby={`${titleId}-moments`}
        >
          <header>
            <p className="msm-eyebrow">The match as you felt it</p>
            <h3 id={`${titleId}-moments`}>Key moments</h3>
          </header>
          {moments.length ? (
            <ol>
              {moments.map((moment, index) => (
                <li
                  key={moment.id}
                  style={{ "--msm-order": index } as CSSProperties}
                >
                  <span>{moment.minute}</span>
                  {moment.team ? (
                    <TeamMark quiet team={moment.team} />
                  ) : (
                    <i className="msm-wire-neutral" />
                  )}
                  <span>
                    <small>{eventLabels[moment.kind]}</small>
                    <b>{moment.title}</b>
                    {moment.detail ? <em>{moment.detail}</em> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="msm-memory-empty">
              No key Moments were saved for this match.
            </p>
          )}
        </section>
        <aside className="msm-memory-side">
          {roomResult ? (
            <section className="msm-room-result" aria-label="Room result">
              <p className="msm-eyebrow">
                {roomResult.roomName} · friend points
              </p>
              <span>
                <b>{ordinal(roomResult.position)}</b>
                <small>of {roomResult.players}</small>
              </span>
              <strong>{roomResult.points.toLocaleString()} points</strong>
              <em>No prizes · no money</em>
            </section>
          ) : null}
          {stats.length ? (
            <details className="msm-memory-stats">
              <summary>
                Open match facts <span>{stats.length} stats</span>
              </summary>
              <div>
                {stats.map((stat) => (
                  <p key={stat.label}>
                    <b>{stat.home}</b>
                    <span>{stat.label}</span>
                    <b>{stat.away}</b>
                  </p>
                ))}
              </div>
            </details>
          ) : null}
        </aside>
      </div>
      <footer className="msm-memory-actions">
        <span>
          {truth.sourceLabel ?? "CANONICAL MATCH DATA"} · revision{" "}
          {truth.revision}
        </span>
        <div>
          <button
            className="msm-memory-replay"
            onClick={onReplay}
            type="button"
          >
            <ReplayIcon /> Replay a Moment
          </button>
          <button className="msm-memory-share" onClick={onShare} type="button">
            <ShareIcon /> Share this memory
          </button>
        </div>
      </footer>
    </article>
  );
}
