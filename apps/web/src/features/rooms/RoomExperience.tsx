import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import "./rooms.css";

import {
  answerCall,
  assignConfidence,
  CALL_STATS,
  createCallDraftFromPicks,
  createInitialCallDraft,
  isCallDraftComplete,
  type CallDraft,
  toCallPicks,
} from "./model.js";
import type {
  CallAnswer,
  CallConfidence,
  CallStat,
  ReactionType,
  RoomApi,
  RoomExperienceRoute,
  RoomFixture,
  RoomInvitePreview,
  RoomLeaderboardRow,
  RoomMember,
  RoomMoment,
  RoomReplayStage,
  RoomTeam,
  RoomView,
} from "./types.js";

type ExperienceStage =
  "create" | "invite" | "loading" | "lobby" | "calls" | "live" | "final";

export interface RoomExperienceProps {
  readonly api: RoomApi;
  readonly onClose?: () => void;
  readonly onExit?: () => void;
  readonly onOpenMatch?: (fixtureId: string) => void;
  readonly onOpenRoom?: (roomId: string) => void;
  readonly route: RoomExperienceRoute;
}

const STAT_LABELS: Readonly<Record<CallStat, string>> = {
  cards: "5+ total cards?",
  corners: "10+ total corners?",
  goals: "3+ total goals?",
};

const REACTION_LABELS: Readonly<Record<ReactionType, string>> = {
  called_it: "CALLED IT",
  cold: "COLD",
  roar: "ROAR",
};

function teamStyle(team: RoomTeam): CSSProperties {
  return {
    "--msr-team": team.primary,
    "--msr-team-ink": team.foreground ?? "#0b0d0c",
    "--msr-team-secondary": team.secondary,
  } as CSSProperties;
}

function fixtureStyle(fixture: RoomFixture): CSSProperties {
  return {
    "--msr-away": fixture.awayTeam.primary,
    "--msr-home": fixture.homeTeam.primary,
  } as CSSProperties;
}

function formatKickoff(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Kickoff time pending";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).format(timestamp);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The room could not update. Try once more.";
}

function initials(nickname: string): string {
  return nickname
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M10 14a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
      <path d="M14 10a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 19l1.1-1.1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m9 7 8 5-8 5V7Z" />
    </svg>
  );
}

function RoomHeader({
  label,
  onClose,
}: {
  label: string;
  onClose?: (() => void) | undefined;
}) {
  return (
    <header className="msr-header">
      <span className="msr-wordmark">
        Match<b>Sense</b>
      </span>
      <span className="msr-header-state">{label}</span>
      {onClose ? (
        <button
          aria-label="Close room"
          className="msr-close"
          onClick={onClose}
          type="button"
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      ) : null}
    </header>
  );
}

export function PointsNotice({ compact = false }: { compact?: boolean }) {
  return (
    <aside className={`msr-points-notice${compact ? " is-compact" : ""}`}>
      <span>Friend points only</span>
      <b>No money. No prizes.</b>
    </aside>
  );
}

export function FixtureBanner({
  fixture,
  score,
  minute,
}: {
  fixture: RoomFixture;
  minute?: string | undefined;
  score?: { readonly away: number; readonly home: number } | undefined;
}) {
  return (
    <section
      aria-label={`${fixture.homeTeam.name} versus ${fixture.awayTeam.name}`}
      className="msr-fixture"
      style={fixtureStyle(fixture)}
    >
      <div className="msr-pitch-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="msr-team-lockup" style={teamStyle(fixture.homeTeam)}>
        <span>{fixture.homeTeam.code}</span>
        <b>{fixture.homeTeam.name}</b>
      </div>
      <div className="msr-fixture-center">
        {score ? (
          <strong>
            {score.home}—{score.away}
          </strong>
        ) : (
          <strong>V</strong>
        )}
        <span>{minute ?? formatKickoff(fixture.kickoffAt)}</span>
      </div>
      <div
        className="msr-team-lockup is-away"
        style={teamStyle(fixture.awayTeam)}
      >
        <span>{fixture.awayTeam.code}</span>
        <b>{fixture.awayTeam.name}</b>
      </div>
    </section>
  );
}

export function MemberRail({
  member,
  viewerMemberId,
}: {
  member: RoomMember;
  viewerMemberId: string;
}) {
  const status =
    member.role === "spectator"
      ? "Spectating"
      : member.callsLocked
        ? "Calls locked"
        : "Making calls";
  return (
    <li className="msr-member">
      <span className="msr-member-mark" aria-hidden="true">
        {initials(member.nickname)}
      </span>
      <span className="msr-member-copy">
        <b>
          {member.nickname}
          {member.id === viewerMemberId ? " · you" : ""}
        </b>
        <small>
          {member.teamCode ?? "Neutral"} · {member.role}
        </small>
      </span>
      <span className="msr-member-status">{status}</span>
    </li>
  );
}

function PrimaryAction({
  children,
  disabled = false,
  onClick,
  type = "button",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      className="msr-primary-action"
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      <span>{children}</span>
      <i aria-hidden="true">
        <ArrowIcon />
      </i>
    </button>
  );
}

function SecondaryAction({
  children,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="msr-secondary-action"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function RoomLobby({
  busy,
  notice,
  onExit,
  onMakeCalls,
  onPlayReplay,
  onShare,
  replayNotice,
  room,
}: {
  busy: boolean;
  notice: string | null;
  onExit?: (() => void) | undefined;
  onMakeCalls: () => void;
  onPlayReplay?: (() => void) | undefined;
  onShare: () => void;
  replayNotice?: string | null | undefined;
  room: RoomView;
}) {
  const viewer = room.members.find(({ id }) => id === room.viewerMemberId);
  const spectator = viewer?.role === "spectator";
  const locked =
    room.calls.locked || room.calls.viewerEntry?.status === "locked";
  return (
    <div className="msr-stage msr-stage--lobby" data-room-stage="lobby">
      <RoomHeader label="Private room" onClose={onExit} />
      <div className="msr-title-block">
        <p className="msr-kicker">{room.name}</p>
        <h1>The room is taking shape.</h1>
        <p>
          One private match ritual. Calls freeze at kickoff; the score stays
          provisional until full-time.
        </p>
      </div>
      <FixtureBanner fixture={room.fixture} />
      {spectator ? (
        <aside className="msr-late-join" role="status">
          <span>You joined after kickoff.</span>
          <b>
            Your friends’ calls are frozen. You can still follow every update.
          </b>
        </aside>
      ) : null}
      <section
        className="msr-member-board"
        aria-labelledby="room-members-title"
      >
        <header>
          <h2 id="room-members-title">In this room</h2>
          <span>{room.members.length} fans</span>
        </header>
        <ul>
          {room.members.map((member) => (
            <MemberRail
              key={member.id}
              member={member}
              viewerMemberId={room.viewerMemberId}
            />
          ))}
        </ul>
      </section>
      {room.inviteUrl ? (
        <div className="msr-invite-strip">
          <span>
            <LinkIcon />
            <small>Private invite ready</small>
          </span>
          <button onClick={onShare} type="button">
            Share invite
          </button>
        </div>
      ) : null}
      {onPlayReplay ? (
        <section
          aria-labelledby="room-replay-title"
          className="msr-replay-conductor"
        >
          <header>
            <span>Replay room · host control</span>
            <b>About four seconds</b>
          </header>
          <div className="msr-replay-conductor-copy">
            <span aria-hidden="true">
              <PlayIcon />
            </span>
            <div>
              <h2 id="room-replay-title">Bring match night to life.</h2>
              <p>
                Everyone in the room follows the same Moment: kickoff, live
                calls, a dramatic review, then the final table.
              </p>
            </div>
          </div>
          <div className="msr-replay-sequence" aria-hidden="true">
            <span>Kickoff</span>
            <i />
            <span>Review</span>
            <i />
            <span>Final</span>
          </div>
          <button disabled={busy} onClick={onPlayReplay} type="button">
            <span>{busy ? "Match replay in motion" : "Play match replay"}</span>
            <i aria-hidden="true">
              <PlayIcon />
            </i>
          </button>
          {replayNotice ? (
            <p className="msr-replay-status" role="status">
              <i aria-hidden="true" />
              {replayNotice}
            </p>
          ) : null}
        </section>
      ) : null}
      {notice ? (
        <p className="msr-inline-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="msr-actions">
        {spectator ? (
          <PrimaryAction onClick={onMakeCalls}>
            Watch the room live
          </PrimaryAction>
        ) : locked ? (
          <PrimaryAction onClick={onMakeCalls}>Open room</PrimaryAction>
        ) : (
          <PrimaryAction disabled={busy} onClick={onMakeCalls}>
            Make my three calls
          </PrimaryAction>
        )}
      </div>
      <PointsNotice compact />
    </div>
  );
}

function ConfidencePicker({
  disabled,
  onChange,
  selected,
  stat,
}: {
  disabled: boolean;
  onChange: (confidence: CallConfidence) => void;
  selected: CallConfidence;
  stat: CallStat;
}) {
  return (
    <div className="msr-confidence" aria-label={`Confidence for ${stat}`}>
      <span>Confidence</span>
      <div>
        {([1, 2, 3] as const).map((confidence) => (
          <button
            aria-pressed={selected === confidence}
            className={selected === confidence ? "is-selected" : ""}
            disabled={disabled}
            key={confidence}
            onClick={() => onChange(confidence)}
            type="button"
          >
            {confidence}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CallThreeRitual({
  busy,
  draft,
  locked,
  onAnswer,
  onConfidence,
  onDone,
  onExit,
  onLock,
  onSave,
  room,
}: {
  busy: boolean;
  draft: CallDraft;
  locked: boolean;
  onAnswer: (stat: CallStat, answer: CallAnswer) => void;
  onConfidence: (stat: CallStat, confidence: CallConfidence) => void;
  onDone: () => void;
  onExit?: (() => void) | undefined;
  onLock: () => void;
  onSave: () => void;
  room: RoomView;
}) {
  const complete = isCallDraftComplete(draft);
  return (
    <div className="msr-stage msr-stage--calls" data-room-stage="calls">
      <RoomHeader label={room.name} onClose={onExit} />
      <div className="msr-title-block">
        <p className="msr-kicker">
          {room.fixture.homeTeam.name} · {room.fixture.awayTeam.name}
        </p>
        <h1>Call Three.</h1>
        <p>
          Three YES or NO calls. Confidence 1, 2, and 3 can each be used once;
          choosing a used number swaps it cleanly.
        </p>
      </div>
      <section className="msr-call-ticket" aria-label="Your three calls">
        <header>
          <b>Your three calls</b>
          <span>Friend points · no prizes</span>
        </header>
        {CALL_STATS.map((stat, index) => (
          <fieldset
            className="msr-call-row"
            disabled={busy || locked}
            key={stat}
          >
            <legend>
              <span>0{index + 1}</span>
              {STAT_LABELS[stat]}
            </legend>
            <div className="msr-call-controls">
              <div className="msr-yes-no" aria-label={`Answer for ${stat}`}>
                {(["no", "yes"] as const).map((answer) => (
                  <button
                    aria-pressed={draft[stat].answer === answer}
                    className={
                      draft[stat].answer === answer ? "is-selected" : ""
                    }
                    key={answer}
                    onClick={() => onAnswer(stat, answer)}
                    type="button"
                  >
                    {answer.toUpperCase()}
                  </button>
                ))}
              </div>
              <ConfidencePicker
                disabled={busy || locked}
                onChange={(confidence) => onConfidence(stat, confidence)}
                selected={draft[stat].confidence}
                stat={stat}
              />
            </div>
          </fieldset>
        ))}
        {locked ? (
          <div className="msr-locked-stamp" role="status">
            <CheckIcon />
            Calls locked · version 1
          </div>
        ) : null}
      </section>
      <p className="msr-score-explainer">
        Correct: confidence 1 = 100 · 2 = 200 · 3 = 300. Maximum 600 friend
        points.
      </p>
      <div className="msr-actions is-split">
        {locked ? (
          <PrimaryAction onClick={onDone}>
            Calls locked · open room
          </PrimaryAction>
        ) : (
          <>
            <SecondaryAction disabled={!complete || busy} onClick={onSave}>
              Save and keep editing
            </SecondaryAction>
            <PrimaryAction disabled={!complete || busy} onClick={onLock}>
              Lock my calls
            </PrimaryAction>
          </>
        )}
      </div>
      <PointsNotice compact />
    </div>
  );
}

export function RoomLeaderboard({
  rows,
  viewerMemberId,
  final = false,
}: {
  final?: boolean;
  rows: readonly RoomLeaderboardRow[];
  viewerMemberId: string;
}) {
  return (
    <section className="msr-leaderboard" aria-labelledby="room-ranking-title">
      <header>
        <h2 id="room-ranking-title">
          {final ? "Friend points · final" : "Room ranking · provisional"}
        </h2>
        <span>{rows.length} fans</span>
      </header>
      {rows.length === 0 ? (
        <p className="msr-empty-row">Rankings appear as calls resolve.</p>
      ) : (
        <ol>
          {rows.map((row) => (
            <li
              className={row.memberId === viewerMemberId ? "is-viewer" : ""}
              key={row.memberId}
            >
              <span>{String(row.rank).padStart(2, "0")}</span>
              <i aria-hidden="true">{initials(row.nickname)}</i>
              <b>
                {row.nickname}
                {row.memberId === viewerMemberId ? " · you" : ""}
              </b>
              <strong>{row.points}</strong>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CurrentMomentRail({
  fixture,
  moment,
}: {
  fixture: RoomFixture;
  moment: RoomMoment;
}) {
  return (
    <section
      className="msr-current-moment"
      data-moment-state={moment.state}
      style={teamStyle(fixture.homeTeam)}
    >
      <span>Current canonical Moment</span>
      <strong>{moment.label}</strong>
      <b>
        {fixture.homeTeam.code} {moment.score.home}—{moment.score.away}{" "}
        {fixture.awayTeam.code}
      </b>
      <small>
        {moment.minute} · revision {moment.revision}
      </small>
    </section>
  );
}

export function ReactionComposer({
  busy,
  members,
  moment,
  onSend,
  viewerMemberId,
}: {
  busy: boolean;
  members: readonly RoomMember[];
  moment: RoomMoment;
  onSend: (recipientMemberId: string, type: ReactionType) => void;
  viewerMemberId: string;
}) {
  const recipients = members.filter(({ id }) => id !== viewerMemberId);
  const [recipient, setRecipient] = useState(recipients[0]?.id ?? "");
  const [reaction, setReaction] = useState<ReactionType>("called_it");
  const held = moment.state === "review";
  const unavailable = moment.state === "overturned" || recipients.length === 0;
  return (
    <section className="msr-reaction-composer" aria-labelledby="poke-title">
      <header>
        <div>
          <p className="msr-kicker">Poke your rival</p>
          <h2 id="poke-title">Send it on this update.</h2>
        </div>
        <span>{held ? "Held during review" : "Controlled reactions"}</span>
      </header>
      <div className="msr-reaction-grid">
        {(Object.keys(REACTION_LABELS) as ReactionType[]).map((type) => (
          <button
            aria-pressed={reaction === type}
            className={reaction === type ? "is-selected" : ""}
            disabled={busy || unavailable}
            key={type}
            onClick={() => setReaction(type)}
            type="button"
          >
            <i aria-hidden="true" />
            {REACTION_LABELS[type]}
          </button>
        ))}
      </div>
      <label className="msr-select-field">
        <span>Send to</span>
        <select
          disabled={busy || unavailable}
          onChange={(event) => setRecipient(event.currentTarget.value)}
          value={recipient}
        >
          {recipients.map((member) => (
            <option key={member.id} value={member.id}>
              {member.nickname} · {member.teamCode ?? "Neutral"}
            </option>
          ))}
        </select>
      </label>
      <p className="msr-revision-note">
        Reactions reference revision {moment.revision}. The match update always
        arrives first.
      </p>
      <PrimaryAction
        disabled={busy || unavailable || recipient.length === 0}
        onClick={() => onSend(recipient, reaction)}
      >
        {held ? "Hold until the review resolves" : "Send on this Moment"}
      </PrimaryAction>
    </section>
  );
}

function ProgressRail({ room }: { room: RoomView }) {
  return (
    <section className="msr-progress" aria-labelledby="call-progress-title">
      <header>
        <h2 id="call-progress-title">Call Three progress</h2>
        <span>Provisional</span>
      </header>
      <ul>
        {room.calls.targets.map((target) => {
          const progress = room.calls.progress[target.stat];
          return (
            <li key={target.stat}>
              <span>
                <b>{target.question}</b>
                <small>
                  {target.reliability === "unreliable"
                    ? "Source marked unreliable · void for everyone"
                    : progress === null
                      ? "Waiting for the first reliable update"
                      : `Current total: ${progress} · resolves at full-time`}
                </small>
              </span>
              <strong>
                {target.reliability === "unreliable" ? "VOID" : "OPEN"}
              </strong>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LiveRoom({
  busy,
  notice,
  onExit,
  onOpenMatch,
  onSendReaction,
  replayNotice,
  room,
}: {
  busy: boolean;
  notice: string | null;
  onExit?: (() => void) | undefined;
  onOpenMatch?: ((fixtureId: string) => void) | undefined;
  onSendReaction: (recipientMemberId: string, type: ReactionType) => void;
  replayNotice?: string | null | undefined;
  room: RoomView;
}) {
  const viewer = room.members.find(({ id }) => id === room.viewerMemberId);
  return (
    <div className="msr-stage msr-stage--live" data-room-stage="live">
      <RoomHeader label={`${room.name} · live`} onClose={onExit} />
      {viewer?.role === "spectator" ? (
        <aside className="msr-late-join is-live" role="status">
          <span>You joined after kickoff.</span>
          <b>Watch the room live. Calls stay closed and honest.</b>
        </aside>
      ) : null}
      {replayNotice ? (
        <p className="msr-replay-status is-live" role="status">
          <i aria-hidden="true" />
          {replayNotice}
        </p>
      ) : null}
      {room.currentMoment ? (
        <CurrentMomentRail fixture={room.fixture} moment={room.currentMoment} />
      ) : (
        <FixtureBanner fixture={room.fixture} minute="LIVE · AWAITING UPDATE" />
      )}
      <div className="msr-live-grid">
        <ProgressRail room={room} />
        <RoomLeaderboard
          rows={room.leaderboard}
          viewerMemberId={room.viewerMemberId}
        />
      </div>
      {room.currentMoment ? (
        <ReactionComposer
          busy={busy}
          members={room.members}
          moment={room.currentMoment}
          onSend={onSendReaction}
          viewerMemberId={room.viewerMemberId}
        />
      ) : null}
      {notice ? (
        <p className="msr-inline-notice" role="status">
          {notice}
        </p>
      ) : null}
      {onOpenMatch ? (
        <SecondaryAction onClick={() => onOpenMatch(room.fixture.id)}>
          Return to Live Companion
        </SecondaryAction>
      ) : null}
      <PointsNotice compact />
    </div>
  );
}

function FinalRoom({
  notice,
  onExit,
  onOpenMatch,
  room,
}: {
  notice?: string | null | undefined;
  onExit?: (() => void) | undefined;
  onOpenMatch?: ((fixtureId: string) => void) | undefined;
  room: RoomView;
}) {
  const viewerRow = room.leaderboard.find(
    ({ memberId }) => memberId === room.viewerMemberId,
  );
  return (
    <div className="msr-stage msr-stage--final" data-room-stage="final">
      <RoomHeader label={`${room.name} · final`} onClose={onExit} />
      {notice ? (
        <p className="msr-replay-status is-final" role="status">
          <i aria-hidden="true" />
          {notice}
        </p>
      ) : null}
      <div className="msr-final-score">
        <span>Final room result</span>
        <strong>{viewerRow ? `#${viewerRow.rank}` : "FT"}</strong>
        <h1>
          {viewerRow?.rank === 1
            ? "You called the night."
            : "The room has spoken."}
        </h1>
        <p>
          {viewerRow
            ? `${viewerRow.points} friend points across ${viewerRow.correctCalls} correct calls.`
            : "Final calls have been reconciled for every friend."}
        </p>
      </div>
      <FixtureBanner
        fixture={room.fixture}
        minute="FULL-TIME · FINALISED"
        score={room.currentMoment?.score}
      />
      <RoomLeaderboard
        final
        rows={room.leaderboard}
        viewerMemberId={room.viewerMemberId}
      />
      <PointsNotice />
      {onOpenMatch ? (
        <PrimaryAction onClick={() => onOpenMatch(room.fixture.id)}>
          Open Match Memory
        </PrimaryAction>
      ) : null}
    </div>
  );
}

function CreateRoomScreen({
  busy,
  error,
  fixture,
  initialNickname,
  initialRoomName,
  onCreate,
  onExit,
}: {
  busy: boolean;
  error: string | null;
  fixture: RoomFixture;
  initialNickname: string;
  initialRoomName: string;
  onCreate: (roomName: string, nickname: string) => void;
  onExit?: (() => void) | undefined;
}) {
  const [roomName, setRoomName] = useState(initialRoomName);
  const [nickname, setNickname] = useState(initialNickname);
  const valid = roomName.trim().length >= 2 && nickname.trim().length >= 2;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid && !busy) onCreate(roomName.trim(), nickname.trim());
  }
  return (
    <div className="msr-stage msr-stage--door" data-room-stage="create">
      <RoomHeader label="Private room" onClose={onExit} />
      <div className="msr-title-block">
        <p className="msr-kicker">Play beside the match</p>
        <h1>Create the match ritual.</h1>
        <p>
          No contacts access. No public feed. One private invite for this
          fixture.
        </p>
      </div>
      <FixtureBanner fixture={fixture} />
      <form className="msr-room-form" onSubmit={submit}>
        <label>
          <span>Room name</span>
          <input
            autoComplete="off"
            maxLength={36}
            onChange={(event) => setRoomName(event.currentTarget.value)}
            placeholder="Finals Night"
            value={roomName}
          />
          <small>Only invited friends see this name.</small>
        </label>
        <label>
          <span>Your nickname</span>
          <input
            autoComplete="nickname"
            maxLength={24}
            onChange={(event) => setNickname(event.currentTarget.value)}
            placeholder="Abhinav"
            value={nickname}
          />
          <small>No account or contacts permission required.</small>
        </label>
        {error ? (
          <p className="msr-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <PrimaryAction disabled={!valid || busy} type="submit">
          {busy ? "Opening private room" : "Create room and invite friends"}
        </PrimaryAction>
      </form>
      <PointsNotice />
    </div>
  );
}

function InviteScreen({
  busy,
  defaultNickname,
  error,
  onExit,
  onJoin,
  preview,
}: {
  busy: boolean;
  defaultNickname: string;
  error: string | null;
  onExit?: (() => void) | undefined;
  onJoin: (nickname: string) => void;
  preview: RoomInvitePreview;
}) {
  const [nickname, setNickname] = useState(defaultNickname);
  const valid = nickname.trim().length >= 2;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid && !busy) onJoin(nickname.trim());
  }
  return (
    <div className="msr-stage msr-stage--door" data-room-stage="invite">
      <RoomHeader label="Invite · valid" onClose={onExit} />
      <div className="msr-title-block">
        <p className="msr-kicker">{preview.hostNickname} invited you</p>
        <h1>{preview.roomName}.</h1>
        <p>
          {preview.fixture.homeTeam.name} vs {preview.fixture.awayTeam.name} ·
          calls lock at {formatKickoff(preview.fixture.kickoffAt)}.
        </p>
      </div>
      <FixtureBanner fixture={preview.fixture} />
      <div className="msr-invite-people" aria-label="Fans already in this room">
        {preview.memberNicknames.map((member) => (
          <span key={member}>
            <i aria-hidden="true">{initials(member)}</i>
            {member}
          </span>
        ))}
      </div>
      {preview.callsLocked ? (
        <aside className="msr-late-join" role="status">
          <span>Kickoff has passed.</span>
          <b>You will join as a spectator; existing calls remain frozen.</b>
        </aside>
      ) : null}
      <form className="msr-room-form" onSubmit={submit}>
        <label>
          <span>Your nickname</span>
          <input
            autoComplete="nickname"
            maxLength={24}
            onChange={(event) => setNickname(event.currentTarget.value)}
            placeholder="Yash"
            value={nickname}
          />
          <small>No account is required for this private room.</small>
        </label>
        {error ? (
          <p className="msr-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <PrimaryAction disabled={!valid || busy} type="submit">
          {preview.callsLocked ? "Join and watch live" : "Join and make calls"}
        </PrimaryAction>
      </form>
      <PointsNotice compact />
    </div>
  );
}

function LoadingRoom({ onExit }: { onExit?: (() => void) | undefined }) {
  return (
    <div className="msr-stage msr-stage--loading" data-room-stage="loading">
      <RoomHeader label="Private room" onClose={onExit} />
      <div className="msr-loading-copy">
        <span aria-hidden="true" />
        <p>Opening the private room</p>
        <small>Checking the current lock and match state.</small>
      </div>
      <div className="msr-skeleton" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function initialStage(route: RoomExperienceRoute): ExperienceStage {
  if (route.mode === "create") return "create";
  if (route.mode === "invite") return route.preview ? "invite" : "loading";
  if (!route.initialRoom) return "loading";
  if (route.initialRoom.phase === "final") return "final";
  if (route.initialRoom.phase === "live") return "live";
  return "lobby";
}

const REPLAY_NOTICES: Readonly<Record<RoomReplayStage, string>> = {
  calls_resolved: "Calls are resolving live across the room.",
  confirmed: "Review complete. The Moment stands.",
  final: "Replay complete. Full-time has been reconciled.",
  kickoff: "Kickoff. Every friend is now following live.",
  under_review: "Under review. Celebration and reactions are held.",
};

export function RoomExperience({
  api,
  onClose,
  onExit,
  onOpenMatch,
  onOpenRoom,
  route,
}: RoomExperienceProps) {
  const initialRoom =
    route.mode === "room" ? (route.initialRoom ?? null) : null;
  const initialPreview =
    route.mode === "invite" ? (route.preview ?? null) : null;
  const [stage, setStage] = useState<ExperienceStage>(() =>
    initialStage(route),
  );
  const [room, setRoom] = useState<RoomView | null>(initialRoom);
  const [preview, setPreview] = useState<RoomInvitePreview | null>(
    initialPreview,
  );
  const [draft, setDraft] = useState<CallDraft>(() =>
    initialRoom?.calls.viewerEntry
      ? createCallDraftFromPicks(initialRoom.calls.viewerEntry.picks)
      : createInitialCallDraft(),
  );
  const [draftTouched, setDraftTouched] = useState(false);
  const [lockedLocally, setLockedLocally] = useState(
    initialRoom?.calls.viewerEntry?.status === "locked",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replayNotice, setReplayNotice] = useState<string | null>(null);
  const exit = onExit ?? onClose;

  const roomId = room?.id ?? null;
  const viewerMemberId = room?.viewerMemberId ?? null;

  useEffect(() => {
    if (route.mode !== "invite" || route.preview) return;
    let alive = true;
    setBusy(true);
    api
      .previewInvite(route.inviteCode)
      .then((nextPreview) => {
        if (!alive) return;
        setPreview(nextPreview);
        setStage("invite");
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(errorMessage(cause));
        setStage("invite");
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [api, route]);

  useEffect(() => {
    if (route.mode !== "room" || route.initialRoom) return;
    let alive = true;
    setBusy(true);
    api
      .getRoom(route.roomId)
      .then((nextRoom) => {
        if (!alive) return;
        setRoom(nextRoom);
        setStage(
          nextRoom.phase === "final"
            ? "final"
            : nextRoom.phase === "live"
              ? "live"
              : "lobby",
        );
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [api, route]);

  useEffect(() => {
    if (roomId === null || viewerMemberId === null) return;
    return api.subscribeRoom(
      roomId,
      viewerMemberId,
      (nextRoom) => {
        setRoom(nextRoom);
        if (nextRoom.phase === "final") setStage("final");
        else if (nextRoom.phase === "live") setStage("live");
      },
      (cause) => setError(errorMessage(cause)),
    );
  }, [api, roomId, viewerMemberId]);

  useEffect(() => {
    if (draftTouched || room?.calls.viewerEntry === null || room === null)
      return;
    setDraft(createCallDraftFromPicks(room.calls.viewerEntry.picks));
    setLockedLocally(room.calls.viewerEntry.status === "locked");
  }, [draftTouched, room]);

  const targetVersions = useMemo(() => {
    const targets = room?.calls.targets ?? [];
    return {
      cards: targets.find(({ stat }) => stat === "cards")?.version ?? 1,
      corners: targets.find(({ stat }) => stat === "corners")?.version ?? 1,
      goals: targets.find(({ stat }) => stat === "goals")?.version ?? 1,
    };
  }, [room]);

  async function createRoom(roomName: string, nickname: string) {
    if (route.mode !== "create") return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createRoom({
        fixtureId: route.fixture.id,
        name: roomName,
        nickname,
      });
      setRoom({ ...created.room, inviteUrl: created.inviteUrl });
      setStage("lobby");
      onOpenRoom?.(created.room.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(nickname: string) {
    if (route.mode !== "invite") return;
    setBusy(true);
    setError(null);
    try {
      const joined = await api.joinRoom({
        inviteCode: route.inviteCode,
        nickname,
        teamCode: route.teamCode ?? null,
      });
      setRoom(joined.room);
      setStage(
        joined.lateJoin || joined.room.phase === "live" ? "live" : "lobby",
      );
      onOpenRoom?.(joined.room.id);
      if (joined.lateJoin)
        setNotice("You joined after kickoff. Calls remain frozen.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function shareInvite() {
    if (!room?.inviteUrl) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function"
      ) {
        await navigator.share({
          text: `Join ${room.name} for ${room.fixture.homeTeam.name} vs ${room.fixture.awayTeam.name}. Friend points only.`,
          title: `${room.name} · MatchSense`,
          url: room.inviteUrl,
        });
        setNotice("Invite shared.");
        return;
      }
      const clipboard =
        typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clipboard) {
        await clipboard.writeText(room.inviteUrl);
        setNotice("Private invite copied.");
        return;
      }
      setNotice(room.inviteUrl);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function saveCalls(lock: boolean) {
    if (!room || !isCallDraftComplete(draft)) return;
    setBusy(true);
    setError(null);
    try {
      const nextRoom = await api.saveCalls(room.id, {
        lock,
        picks: toCallPicks(draft),
        targetVersions,
      });
      setRoom(nextRoom);
      setDraftTouched(false);
      setLockedLocally(lock || nextRoom.calls.viewerEntry?.status === "locked");
      setNotice(
        lock
          ? "Calls locked at the current server time."
          : "Calls saved. You can edit them until kickoff.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendReaction(recipientMemberId: string, type: ReactionType) {
    if (!room?.currentMoment) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.sendReaction(room.id, {
        momentId: room.currentMoment.momentId,
        momentRevision: room.currentMoment.revision,
        recipientMemberId,
        type,
      });
      setRoom(result.room);
      setNotice(
        room.currentMoment.state === "review"
          ? "Reaction held until the review resolves."
          : "Reaction sent after the match update.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function playReplay() {
    if (!room || !room.fixture.isReplay) return;
    const viewer = room.members.find(({ id }) => id === room.viewerMemberId);
    if (viewer?.role !== "host") return;
    setBusy(true);
    setError(null);
    setReplayNotice("The room is lining up for kickoff.");
    try {
      const finalRoom = await api.playReplay(room.id, (update) => {
        setRoom(update.room);
        setReplayNotice(REPLAY_NOTICES[update.stage]);
        setStage(
          update.room.phase === "final"
            ? "final"
            : update.room.phase === "live"
              ? "live"
              : "lobby",
        );
      });
      setRoom(finalRoom);
      setStage("final");
      setReplayNotice(REPLAY_NOTICES.final);
    } catch (cause) {
      setError(errorMessage(cause));
      setReplayNotice("Replay paused before full-time. Try once more.");
    } finally {
      setBusy(false);
    }
  }

  if (stage === "loading") return <LoadingRoom onExit={exit} />;
  if (stage === "create" && route.mode === "create") {
    return (
      <CreateRoomScreen
        busy={busy}
        error={error}
        fixture={route.fixture}
        initialNickname={route.defaultNickname ?? ""}
        initialRoomName={route.defaultRoomName ?? ""}
        onCreate={(roomName, nickname) => void createRoom(roomName, nickname)}
        onExit={exit}
      />
    );
  }
  if (stage === "invite" && preview && route.mode === "invite") {
    return (
      <InviteScreen
        busy={busy}
        defaultNickname={route.defaultNickname ?? ""}
        error={error}
        onExit={exit}
        onJoin={(nickname) => void joinRoom(nickname)}
        preview={preview}
      />
    );
  }
  if (!room) {
    return (
      <div className="msr-stage msr-stage--error" data-room-stage="error">
        <RoomHeader label="Room unavailable" onClose={exit} />
        <p role="alert">
          {error ?? "This private room is no longer available."}
        </p>
      </div>
    );
  }
  if (stage === "final") {
    return (
      <FinalRoom
        notice={replayNotice}
        onExit={exit}
        onOpenMatch={onOpenMatch}
        room={room}
      />
    );
  }
  if (stage === "live") {
    return (
      <LiveRoom
        busy={busy}
        notice={error ?? notice}
        onExit={exit}
        onOpenMatch={onOpenMatch}
        onSendReaction={(recipient, type) => void sendReaction(recipient, type)}
        replayNotice={replayNotice}
        room={room}
      />
    );
  }
  if (stage === "calls") {
    return (
      <CallThreeRitual
        busy={busy}
        draft={draft}
        locked={lockedLocally || room.calls.locked}
        onAnswer={(stat, answer) => {
          setDraft((current) => answerCall(current, stat, answer));
          setDraftTouched(true);
        }}
        onConfidence={(stat, confidence) => {
          setDraft((current) => assignConfidence(current, stat, confidence));
          setDraftTouched(true);
        }}
        onDone={() => setStage(room.phase === "live" ? "live" : "lobby")}
        onExit={exit}
        onLock={() => void saveCalls(true)}
        onSave={() => void saveCalls(false)}
        room={room}
      />
    );
  }
  const viewer = room.members.find(({ id }) => id === room.viewerMemberId);
  const canPlayReplay =
    room.fixture.isReplay && viewer?.role === "host" && room.phase !== "final";
  return (
    <RoomLobby
      busy={busy}
      notice={error ?? notice}
      onExit={exit}
      onMakeCalls={() =>
        setStage(
          room.members.find(({ id }) => id === room.viewerMemberId)?.role ===
            "spectator" || room.phase === "live"
            ? "live"
            : "calls",
        )
      }
      onPlayReplay={canPlayReplay ? () => void playReplay() : undefined}
      onShare={() => void shareInvite()}
      replayNotice={replayNotice}
      room={room}
    />
  );
}
