import { type FormEvent, useEffect, useState } from "react";

import { TeamFlag } from "../../components/TeamFlag.js";
import type { ProductTeam } from "../../live-api.js";

import {
  assignCallThreeConfidence,
  createInitialCallThreeDraft,
  isCallThreeDraftComplete,
  selectCallThreeAnswer,
  toCallThreeSubmission,
  type CallThreeConfidence,
  type CallThreeDraft,
  type CallThreeTarget,
} from "./model.js";
import type {
  CallThreeRoomApi,
  CallThreeRoomView,
  CreatedCallThreeRoom,
  RoomCreationFixture,
  RoomExperienceRoute,
  RoomInvitePreview,
  RoomMember,
  RoomStatus,
} from "./types.js";

import "./rooms.css";

export interface RoomExperienceProps {
  readonly api: CallThreeRoomApi;
  readonly defaultNickname: string;
  readonly favoriteTeam: string | null;
  readonly onExit?: (() => void) | undefined;
  readonly onOpenRoom?: ((roomId: string) => void) | undefined;
  readonly route: RoomExperienceRoute;
  readonly teams: readonly ProductTeam[];
}

const FALLBACK_TEAM_COLORS: Readonly<Record<string, ProductTeam>> = {
  ARG: {
    code: "ARG",
    name: "Argentina",
    primary: "#78bde9",
    secondary: "#f5f0df",
  },
  BRA: {
    code: "BRA",
    name: "Brazil",
    primary: "#ddc94c",
    secondary: "#1c8a4d",
  },
  ENG: {
    code: "ENG",
    name: "England",
    primary: "#f7f5ed",
    secondary: "#c92232",
  },
  ESP: { code: "ESP", name: "Spain", primary: "#bf2434", secondary: "#edc64a" },
  FRA: {
    code: "FRA",
    name: "France",
    primary: "#1d4d91",
    secondary: "#e9eceb",
  },
  JPN: { code: "JPN", name: "Japan", primary: "#f5f1e8", secondary: "#c63a4d" },
};

const REACTION_LABELS = [
  ["ROAR", "ROAR"],
  ["COLD", "COLD"],
  ["CALLED_IT", "CALLED IT"],
] as const;

function teamFor(code: string, teams: readonly ProductTeam[]): ProductTeam {
  return (
    teams.find((team) => team.code === code) ??
    FALLBACK_TEAM_COLORS[code] ?? {
      code,
      name: code,
      primary: "#7a897c",
      secondary: "#eae5d8",
    }
  );
}

function timeLabel(value: number | string) {
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at)) return "Kickoff time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(at);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The Room could not update.";
}

function roomStatusLabel(status: RoomStatus) {
  if (status === "PRE_KICKOFF") return "PRE-KICKOFF";
  if (status === "LIVE") return "LIVE · PROVISIONAL";
  return "VERIFIED FINAL";
}

function isEligibleFixture(fixture: RoomCreationFixture) {
  const kickoffAt = fixture.kickoffAt
    ? Date.parse(fixture.kickoffAt)
    : Number.NaN;
  return (
    fixture.provenance === "live_txline" &&
    fixture.mode !== "recorded" &&
    fixture.lifecycle === "SCHEDULED" &&
    (fixture.phase === undefined || fixture.phase === "scheduled") &&
    Number.isFinite(kickoffAt) &&
    kickoffAt > Date.now()
  );
}

interface CallThreeInviteInput {
  readonly invitePath: string;
  readonly roomName: string;
}

interface CallThreeInvitePort {
  readonly origin: string;
  readonly share?: ((data: ShareData) => Promise<void>) | undefined;
  readonly writeText: (text: string) => Promise<void>;
}

function absoluteInviteUrl(invitePath: string, origin: string) {
  return new URL(invitePath, origin).toString();
}

export async function copyCallThreeInvite(
  invite: CallThreeInviteInput,
  port: CallThreeInvitePort,
) {
  await port.writeText(absoluteInviteUrl(invite.invitePath, port.origin));
}

export async function shareCallThreeInvite(
  invite: CallThreeInviteInput,
  port: CallThreeInvitePort,
) {
  const url = absoluteInviteUrl(invite.invitePath, port.origin);
  if (port.share) {
    await port.share({
      text: "Join my private Call Three Room before kickoff.",
      title: `${invite.roomName} · MatchSense`,
      url,
    });
    return;
  }
  await port.writeText(url);
}

function browserInvitePort(): CallThreeInvitePort {
  const capabilities = navigator as unknown as {
    readonly clipboard?: Pick<Clipboard, "writeText"> | undefined;
    readonly share?: ((data: ShareData) => Promise<void>) | undefined;
  };
  const clipboard = capabilities.clipboard;
  const writeText = clipboard?.writeText.bind(clipboard);
  const share = capabilities.share?.bind(navigator);
  return {
    origin: window.location.origin,
    ...(share ? { share } : {}),
    writeText: writeText
      ? (text) => writeText(text)
      : async () => {
          throw new Error("Clipboard sharing is unavailable");
        },
  };
}

function callsToDraft(room: CallThreeRoomView): CallThreeDraft {
  if (!room.myCalls) return createInitialCallThreeDraft();
  return {
    cards: room.myCalls.calls.cards,
    goals: room.myCalls.calls.goals,
    result: room.myCalls.calls.result,
  };
}

function Header({
  label,
  onExit,
}: {
  readonly label: string;
  readonly onExit: (() => void) | undefined;
}) {
  return (
    <header className="msr-header">
      <span className="msr-wordmark">
        Match<span>Sense</span>
      </span>
      <span className="msr-header-status">{label}</span>
      {onExit ? (
        <button className="msr-quiet-button" onClick={onExit} type="button">
          Back to Match Day
        </button>
      ) : null}
    </header>
  );
}

function FixtureStrip({
  fixture,
  teams,
}: {
  readonly fixture: {
    readonly awayTeam: string;
    readonly homeTeam: string;
    readonly kickoffAt: string;
  };
  readonly teams: readonly ProductTeam[];
}) {
  const home = teamFor(fixture.homeTeam, teams);
  const away = teamFor(fixture.awayTeam, teams);
  return (
    <section
      className="msr-fixture-strip"
      aria-label={`${home.name} versus ${away.name}`}
    >
      <div className="msr-fixture-team">
        <TeamFlag size="standard" team={home} />
        <div>
          <b>{home.code}</b>
          <span>{home.name}</span>
        </div>
      </div>
      <div className="msr-fixture-time">
        <b>V</b>
        <span>{timeLabel(fixture.kickoffAt)}</span>
      </div>
      <div className="msr-fixture-team is-away">
        <div>
          <b>{away.code}</b>
          <span>{away.name}</span>
        </div>
        <TeamFlag size="standard" team={away} />
      </div>
    </section>
  );
}

function PointsBand({ room }: { readonly room: CallThreeRoomView }) {
  return (
    <aside className="msr-points-band">
      <span>{room.points.label}</span>
      <b>{room.points.lifetimeTotal} lifetime</b>
      <small>{room.points.roomPoints} from this Room</small>
    </aside>
  );
}

function CallCard({
  disabled,
  draft,
  label,
  options,
  target,
  onAnswer,
  onConfidence,
}: {
  readonly disabled: boolean;
  readonly draft: CallThreeDraft;
  readonly label: string;
  readonly options: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly target: CallThreeTarget;
  readonly onAnswer: (value: string) => void;
  readonly onConfidence: (value: CallThreeConfidence) => void;
}) {
  const entry = draft[target];
  return (
    <article className="msr-call-card">
      <header>
        <span>
          {target === "result"
            ? "CALL 01"
            : target === "goals"
              ? "CALL 02"
              : "CALL 03"}
        </span>
        <b>{label}</b>
      </header>
      <div className="msr-option-row" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            className={entry.answer === option.value ? "is-selected" : ""}
            disabled={disabled}
            key={option.value}
            onClick={() => onAnswer(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <div
        className="msr-confidence-row"
        role="group"
        aria-label={`${label} confidence`}
      >
        <span>Confidence</span>
        {([3, 2, 1] as const).map((value) => (
          <button
            className={entry.confidence === value ? "is-selected" : ""}
            disabled={disabled}
            key={value}
            onClick={() => onConfidence(value)}
            type="button"
          >
            {value}
          </button>
        ))}
      </div>
    </article>
  );
}

function CallThreeComposer({
  api,
  room,
  onRoom,
}: {
  readonly api: CallThreeRoomApi;
  readonly room: CallThreeRoomView;
  readonly onRoom: (room: CallThreeRoomView) => void;
}) {
  const [draft, setDraft] = useState<CallThreeDraft>(() => callsToDraft(room));
  const [busy, setBusy] = useState<"save" | "lock" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const viewer = room.members.find(
    (member) => member.id === room.viewerParticipantId,
  );
  const callsAreLocked = room.myCalls?.lockedAt != null;
  const editable =
    room.status === "PRE_KICKOFF" &&
    viewer?.role === "PLAYER" &&
    !callsAreLocked;
  const disabled = !editable;
  useEffect(
    () => setDraft(callsToDraft(room)),
    [room.id, room.myCalls?.changedAt, room.myCalls?.lockedAt],
  );

  const save = async (lock: boolean) => {
    if (!isCallThreeDraftComplete(draft)) {
      setFault(
        "Choose all three calls and assign confidence 3, 2, and 1 once each.",
      );
      return;
    }
    setBusy(lock ? "lock" : "save");
    setFault(null);
    try {
      const saved = await api.setCalls(room.id, toCallThreeSubmission(draft));
      const next = lock ? await api.lockCalls(saved.id) : saved;
      onRoom(next);
      setNotice(
        lock
          ? "Your Calls are locked for this match."
          : "Your Calls are saved. You can still edit them before kickoff.",
      );
    } catch (error) {
      setFault(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  if (viewer?.role === "SPECTATOR") {
    return (
      <section className="msr-call-locked" role="status">
        <b>Viewer seat</b>
        <span>
          You joined after kickoff, so you can follow the Room but cannot make
          Calls.
        </span>
      </section>
    );
  }

  if (room.status !== "PRE_KICKOFF" || callsAreLocked) {
    return (
      <section className="msr-call-locked" role="status">
        <b>Calls locked at official kickoff</b>
        <span>
          {room.myCalls
            ? "Your three Calls are sealed. The table will update from verified match facts."
            : "No Calls were locked before kickoff."}
        </span>
      </section>
    );
  }

  return (
    <section className="msr-calls" aria-labelledby="call-three-title">
      <header className="msr-section-heading">
        <div>
          <span>PRE-MATCH RITUAL</span>
          <h2 id="call-three-title">Call Three</h2>
        </div>
        <p>Three calls. Confidence 3, 2, and 1, used once each.</p>
      </header>
      <div className="msr-call-grid">
        <CallCard
          disabled={disabled}
          draft={draft}
          label="Regulation result"
          onAnswer={(answer) =>
            setDraft((current) =>
              selectCallThreeAnswer(
                current,
                "result",
                answer as "HOME" | "DRAW" | "AWAY",
              ),
            )
          }
          onConfidence={(confidence) =>
            setDraft((current) =>
              assignCallThreeConfidence(current, "result", confidence),
            )
          }
          options={[
            { label: room.fixture.homeTeam, value: "HOME" },
            { label: "Draw", value: "DRAW" },
            { label: room.fixture.awayTeam, value: "AWAY" },
          ]}
          target="result"
        />
        <CallCard
          disabled={disabled}
          draft={draft}
          label="3+ total goals"
          onAnswer={(answer) =>
            setDraft((current) =>
              selectCallThreeAnswer(current, "goals", answer as "YES" | "NO"),
            )
          }
          onConfidence={(confidence) =>
            setDraft((current) =>
              assignCallThreeConfidence(current, "goals", confidence),
            )
          }
          options={[
            { label: "Yes", value: "YES" },
            { label: "No", value: "NO" },
          ]}
          target="goals"
        />
        <CallCard
          disabled={disabled}
          draft={draft}
          label="5+ total cards"
          onAnswer={(answer) =>
            setDraft((current) =>
              selectCallThreeAnswer(current, "cards", answer as "YES" | "NO"),
            )
          }
          onConfidence={(confidence) =>
            setDraft((current) =>
              assignCallThreeConfidence(current, "cards", confidence),
            )
          }
          options={[
            { label: "Yes", value: "YES" },
            { label: "No", value: "NO" },
          ]}
          target="cards"
        />
      </div>
      <div className="msr-call-actions">
        <button
          className="msr-secondary-action"
          disabled={busy !== null || !isCallThreeDraftComplete(draft)}
          onClick={() => void save(false)}
          type="button"
        >
          {busy === "save" ? "Saving Calls" : "Save Calls"}
        </button>
        <button
          className="msr-primary-action"
          disabled={busy !== null || !isCallThreeDraftComplete(draft)}
          onClick={() => void save(true)}
          type="button"
        >
          {busy === "lock" ? "Locking Calls" : "Lock Calls"}
        </button>
      </div>
      {notice ? (
        <p className="msr-inline-notice" role="status">
          {notice}
        </p>
      ) : null}
      {fault ? (
        <p className="msr-inline-error" role="alert">
          {fault}
        </p>
      ) : null}
    </section>
  );
}

function TargetResolution({
  label,
  target,
}: {
  readonly label: string;
  readonly target: CallThreeRoomView["targets"][CallThreeTarget];
}) {
  if (!target) {
    return (
      <span className="msr-target-state">Awaiting verified final fact</span>
    );
  }
  if (target.state === "VOID") {
    return (
      <span className="msr-target-state is-void">
        <b>VOID</b>
        <small>
          {label}: {target.reason}
        </small>
      </span>
    );
  }
  return (
    <span className="msr-target-state is-resolved">
      <b>{target.answer}</b>
      <small>{label} confirmed</small>
    </span>
  );
}

function Leaderboard({ room }: { readonly room: CallThreeRoomView }) {
  return (
    <section className="msr-leaderboard" aria-labelledby="room-table-title">
      <header className="msr-section-heading">
        <div>
          <span>
            {room.status === "FINAL" ? "VERIFIED FINAL" : "LIVE · PROVISIONAL"}
          </span>
          <h2 id="room-table-title">Room table</h2>
        </div>
        <p>Correct Calls add MatchSense Points after verified facts arrive.</p>
      </header>
      <div className="msr-resolution-grid">
        <TargetResolution
          label="Regulation result"
          target={room.targets.result}
        />
        <TargetResolution label="3+ total goals" target={room.targets.goals} />
        <TargetResolution label="5+ total cards" target={room.targets.cards} />
      </div>
      {room.leaderboard.length ? (
        <ol className="msr-table-list">
          {room.leaderboard.map((entry) => (
            <li key={entry.participantId}>
              <span>{entry.rank}</span>
              <b>{entry.nickname}</b>
              <small>
                {entry.correctCalls} correct · {entry.voidCalls} void
              </small>
              <strong>{entry.score}</strong>
              {entry.provisional ? <em>PROVISIONAL</em> : <em>FINAL</em>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="msr-empty-copy">
          The table appears after players save their Calls.
        </p>
      )}
    </section>
  );
}

function Reactions({
  api,
  room,
  onRoom,
}: {
  readonly api: CallThreeRoomApi;
  readonly room: CallThreeRoomView;
  readonly onRoom: (room: CallThreeRoomView) => void;
}) {
  const [fault, setFault] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const moment =
    room.currentMoment?.varState === "CLEAR" ? room.currentMoment : null;
  const recipients = room.members.filter(
    (member) => member.id !== room.viewerParticipantId,
  );

  const react = async (
    member: RoomMember,
    kind: "ROAR" | "COLD" | "CALLED_IT",
  ) => {
    if (!moment) return;
    setBusy(true);
    setFault(null);
    try {
      const result = await api.react(room.id, {
        kind,
        momentId: moment.momentId,
        recipientParticipantId: member.id,
        revision: moment.revision,
      });
      onRoom(result.room);
    } catch (error) {
      setFault(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="msr-reactions" aria-labelledby="room-reactions-title">
      <header className="msr-section-heading">
        <div>
          <span>CONFIRMED MOMENT REACTIONS</span>
          <h2 id="room-reactions-title">The group feels it together.</h2>
        </div>
        <p>
          Only confirmed Moments can carry a reaction. Corrections stay visible.
        </p>
      </header>
      {moment && recipients.length ? (
        <div className="msr-reaction-grid">
          {recipients.map((member) => (
            <article key={member.id}>
              <b>{member.nickname}</b>
              <span>Moment {moment.revision} confirmed</span>
              <div>
                {REACTION_LABELS.map(([kind, label]) => (
                  <button
                    disabled={busy}
                    key={kind}
                    onClick={() => void react(member, kind)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="msr-empty-copy">
          Reactions unlock after a confirmed Match Moment.
        </p>
      )}
      {room.reactions.length ? (
        <ul className="msr-reaction-history">
          {room.reactions.map((reaction) => (
            <li
              className={
                reaction.status === "OVERTURNED" ? "is-overturned" : ""
              }
              key={reaction.id}
            >
              <b>{reaction.senderNickname}</b>
              <span>
                {reaction.kind.replaceAll("_", " ")} to{" "}
                {reaction.recipientNickname}
              </span>
              <small>
                {reaction.status === "OVERTURNED" ? "OVERTURNED" : "CONFIRMED"}
              </small>
            </li>
          ))}
        </ul>
      ) : null}
      {fault ? (
        <p className="msr-inline-error" role="alert">
          {fault}
        </p>
      ) : null}
    </section>
  );
}

function RoomScreen({
  api,
  onExit,
  room,
  teams,
  updateRoom,
}: {
  readonly api: CallThreeRoomApi;
  readonly onExit: (() => void) | undefined;
  readonly room: CallThreeRoomView;
  readonly teams: readonly ProductTeam[];
  readonly updateRoom: (room: CallThreeRoomView) => void;
}) {
  return (
    <main className="msr-stage" id="main-content">
      <Header label={roomStatusLabel(room.status)} onExit={onExit} />
      <section className="msr-room-intro">
        <p>PRIVATE MATCH NIGHT</p>
        <h1>{room.name}</h1>
        <span>
          {room.members.length} fans following verified match facts together.
        </span>
      </section>
      <FixtureStrip fixture={room.fixture} teams={teams} />
      <PointsBand room={room} />
      <CallThreeComposer api={api} onRoom={updateRoom} room={room} />
      <Leaderboard room={room} />
      {room.status !== "PRE_KICKOFF" ? (
        <Reactions api={api} onRoom={updateRoom} room={room} />
      ) : null}
    </main>
  );
}

function CreateRoom({
  api,
  defaultNickname,
  favoriteTeam,
  fixture,
  initialCreated,
  onExit,
  onOpenRoom,
  teams,
}: {
  readonly api: CallThreeRoomApi;
  readonly defaultNickname: string;
  readonly favoriteTeam: string | null;
  readonly fixture: RoomCreationFixture;
  readonly initialCreated: CreatedCallThreeRoom | undefined;
  readonly onExit: (() => void) | undefined;
  readonly onOpenRoom: ((roomId: string) => void) | undefined;
  readonly teams: readonly ProductTeam[];
}) {
  const [name, setName] = useState("Match night");
  const [nickname, setNickname] = useState(defaultNickname);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedCallThreeRoom | null>(
    initialCreated ?? null,
  );
  const [inviteState, setInviteState] = useState<
    "idle" | "copied" | "shared" | "error"
  >("idle");
  const eligible = isEligibleFixture(fixture);
  const displayFixture = {
    awayTeam: fixture.awayTeam,
    homeTeam: fixture.homeTeam,
    kickoffAt: fixture.kickoffAt ?? "",
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFault(null);
    try {
      const created = await api.create({
        fixtureId: fixture.fixtureId,
        name,
        nickname,
        teamCode: favoriteTeam,
      });
      setCreated(created);
    } catch (error) {
      setFault(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const invite = created
    ? { invitePath: created.invitePath, roomName: created.room.name }
    : null;

  const copyInvite = async () => {
    if (!invite) return;
    try {
      await copyCallThreeInvite(invite, browserInvitePort());
      setInviteState("copied");
    } catch {
      setInviteState("error");
    }
  };

  const shareInvite = async () => {
    if (!invite) return;
    try {
      const port = browserInvitePort();
      const usedNativeShare = Boolean(port.share);
      await shareCallThreeInvite(invite, port);
      setInviteState(usedNativeShare ? "shared" : "copied");
    } catch {
      setInviteState("error");
    }
  };

  if (created) {
    return (
      <main className="msr-stage" id="main-content">
        <Header label="CALL THREE" onExit={onExit} />
        <section className="msr-room-intro">
          <p>ROOM CREATED · PRIVATE INVITE</p>
          <h1>{created.room.name}</h1>
          <span>
            Your Room is ready. Share this invite before the official kickoff.
          </span>
        </section>
        <FixtureStrip fixture={created.room.fixture} teams={teams} />
        <section
          className="msr-invite-panel"
          aria-labelledby="room-invite-title"
        >
          <span>ONE PRIVATE INVITE</span>
          <h2 id="room-invite-title">Bring your match-night people in.</h2>
          <code>{created.invitePath}</code>
          <small>INVITE CODE · {created.inviteCode}</small>
          <div>
            <button onClick={() => void copyInvite()} type="button">
              Copy invite
            </button>
            <button onClick={() => void shareInvite()} type="button">
              Share invite
            </button>
            <button
              className="msr-primary-action"
              onClick={() => onOpenRoom?.(created.room.id)}
              type="button"
            >
              Open Room
            </button>
          </div>
          {inviteState !== "idle" ? (
            <p
              className={
                inviteState === "error" ? "msr-inline-error" : undefined
              }
              role="status"
            >
              {inviteState === "copied"
                ? "Invite copied."
                : inviteState === "shared"
                  ? "Invite shared."
                  : "This device could not copy or share the invite."}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="msr-stage" id="main-content">
      <Header label="CALL THREE" onExit={onExit} />
      <section className="msr-room-intro">
        <p>PRIVATE PRE-MATCH RITUAL</p>
        <h1>
          {eligible
            ? "Make the match a shared call."
            : "Call Three unavailable"}
        </h1>
        <span>
          {eligible
            ? "Choose exactly three Calls before the official kickoff locks the Room."
            : "Rooms can open only for a scheduled live TxLINE match before kickoff."}
        </span>
      </section>
      <FixtureStrip fixture={displayFixture} teams={teams} />
      {eligible ? (
        <form
          className="msr-room-form"
          onSubmit={(event) => void submit(event)}
        >
          <label>
            <span>Room name</span>
            <input
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label>
            <span>Your match-night name</span>
            <input
              maxLength={30}
              onChange={(event) => setNickname(event.target.value)}
              required
              value={nickname}
            />
          </label>
          <p>
            Calls stay editable until you lock them or the official kickoff
            arrives.
          </p>
          {fault ? (
            <p className="msr-inline-error" role="alert">
              {fault}
            </p>
          ) : null}
          <button
            className="msr-primary-action"
            disabled={busy || !name.trim() || !nickname.trim()}
            type="submit"
          >
            {busy ? "Creating Room" : "Create Call Three Room"}
          </button>
        </form>
      ) : null}
    </main>
  );
}

function InviteRoom({
  api,
  defaultNickname,
  favoriteTeam,
  inviteCode,
  onExit,
  onOpenRoom,
  teams,
}: {
  readonly api: CallThreeRoomApi;
  readonly defaultNickname: string;
  readonly favoriteTeam: string | null;
  readonly inviteCode: string;
  readonly onExit: (() => void) | undefined;
  readonly onOpenRoom: ((roomId: string) => void) | undefined;
  readonly teams: readonly ProductTeam[];
}) {
  const [preview, setPreview] = useState<RoomInvitePreview | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [nickname, setNickname] = useState(defaultNickname);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void api.preview(inviteCode).then(
      (next) => {
        if (active) setPreview(next);
      },
      (error: unknown) => {
        if (active) setFault(errorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, [api, inviteCode]);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFault(null);
    try {
      const room = await api.join({
        inviteCode,
        nickname,
        teamCode: favoriteTeam,
      });
      onOpenRoom?.(room.id);
    } catch (error) {
      setFault(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="msr-stage" id="main-content">
      <Header label="ROOM INVITE" onExit={onExit} />
      {preview ? (
        <>
          <section className="msr-room-intro">
            <p>{preview.hostNickname} INVITED YOU</p>
            <h1>{preview.name}</h1>
            <span>
              {preview.memberCount} fans are gathering before kickoff.
            </span>
          </section>
          <FixtureStrip fixture={preview.fixture} teams={teams} />
          <form
            className="msr-room-form"
            onSubmit={(event) => void join(event)}
          >
            <label>
              <span>Your match-night name</span>
              <input
                maxLength={30}
                onChange={(event) => setNickname(event.target.value)}
                required
                value={nickname}
              />
            </label>
            <p>
              {preview.callsLocked
                ? "Kickoff has passed. You can join as a viewer."
                : "Join, make your three Calls, then lock them before kickoff."}
            </p>
            {fault ? (
              <p className="msr-inline-error" role="alert">
                {fault}
              </p>
            ) : null}
            <button
              className="msr-primary-action"
              disabled={busy || !nickname.trim()}
              type="submit"
            >
              {busy ? "Joining Room" : "Join Room"}
            </button>
          </form>
        </>
      ) : (
        <section className="msr-state-panel" role={fault ? "alert" : "status"}>
          <b>{fault ? "Room unavailable" : "Opening invite"}</b>
          <span>{fault ?? "Fetching the Room’s live match eligibility."}</span>
        </section>
      )}
    </main>
  );
}

function RoomsList({
  api,
  onExit,
  onOpenRoom,
  initialRooms,
  teams,
}: {
  readonly api: CallThreeRoomApi;
  readonly onExit: (() => void) | undefined;
  readonly onOpenRoom: ((roomId: string) => void) | undefined;
  readonly initialRooms: readonly CallThreeRoomView[] | undefined;
  readonly teams: readonly ProductTeam[];
}) {
  const [rooms, setRooms] = useState<readonly CallThreeRoomView[] | null>(
    initialRooms ?? null,
  );
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    if (initialRooms !== undefined) return;
    let active = true;
    void api.list().then(
      (next) => {
        if (active) setRooms(next);
      },
      (error: unknown) => {
        if (active) setFault(errorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, [api, initialRooms]);
  return (
    <main className="msr-stage" id="main-content">
      <Header label="YOUR ROOMS" onExit={onExit} />
      <section className="msr-room-intro">
        <p>PRIVATE MATCH NIGHTS</p>
        <h1>Pick a Room. Feel every swing together.</h1>
        <span>
          Only scheduled live fixtures can open a new Call Three Room.
        </span>
      </section>
      {rooms ? (
        rooms.length ? (
          <div className="msr-room-list">
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => onOpenRoom?.(room.id)}
                type="button"
              >
                <FixtureStrip fixture={room.fixture} teams={teams} />
                <span>{room.name}</span>
                <b>{roomStatusLabel(room.status)}</b>
              </button>
            ))}
          </div>
        ) : (
          <section className="msr-state-panel" role="status">
            <b>No Rooms yet</b>
            <span>
              Open a scheduled match to create a private Call Three Room.
            </span>
          </section>
        )
      ) : (
        <section className="msr-state-panel" role="status">
          <b>Opening Rooms</b>
          <span>Loading your match nights.</span>
        </section>
      )}
      {fault ? (
        <p className="msr-inline-error" role="alert">
          {fault}
        </p>
      ) : null}
    </main>
  );
}

export function RoomExperience({
  api,
  defaultNickname,
  favoriteTeam,
  onExit,
  onOpenRoom,
  route,
  teams,
}: RoomExperienceProps) {
  const [room, setRoom] = useState<CallThreeRoomView | null>(
    route.mode === "room" ? (route.initialRoom ?? null) : null,
  );
  const [fault, setFault] = useState<string | null>(null);
  const roomId = route.mode === "room" ? route.roomId : null;
  const initialRoom = route.mode === "room" ? route.initialRoom : undefined;
  const hasRoom = room !== null;

  useEffect(() => {
    if (!roomId) return;
    if (initialRoom) {
      setRoom(initialRoom);
      setFault(null);
      return;
    }
    let active = true;
    setRoom(null);
    setFault(null);
    void api.get(roomId).then(
      (next) => {
        if (active) setRoom(next);
      },
      (error: unknown) => {
        if (active) setFault(errorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, [api, initialRoom, roomId]);

  useEffect(() => {
    if (!roomId || !hasRoom || room?.id !== roomId) return;
    return api.subscribe(
      roomId,
      (incoming) => {
        setRoom((current) =>
          !current || incoming.revision >= current.revision
            ? incoming
            : current,
        );
      },
      (error) => setFault(errorMessage(error)),
    );
  }, [api, hasRoom, roomId]);

  if (route.mode === "list") {
    return (
      <RoomsList
        api={api}
        initialRooms={route.initialRooms}
        onExit={onExit}
        onOpenRoom={onOpenRoom}
        teams={teams}
      />
    );
  }
  if (route.mode === "create") {
    return (
      <CreateRoom
        api={api}
        defaultNickname={defaultNickname}
        favoriteTeam={favoriteTeam}
        fixture={route.fixture}
        initialCreated={route.initialCreated}
        onExit={onExit}
        onOpenRoom={onOpenRoom}
        teams={teams}
      />
    );
  }
  if (route.mode === "invite") {
    return (
      <InviteRoom
        api={api}
        defaultNickname={defaultNickname}
        favoriteTeam={favoriteTeam}
        inviteCode={route.inviteCode}
        onExit={onExit}
        onOpenRoom={onOpenRoom}
        teams={teams}
      />
    );
  }
  if (!room) {
    return (
      <main className="msr-stage" id="main-content">
        <Header label="ROOM" onExit={onExit} />
        <section className="msr-state-panel" role={fault ? "alert" : "status"}>
          <b>{fault ? "Room unavailable" : "Opening Room"}</b>
          <span>{fault ?? "Loading the Room’s durable match state."}</span>
        </section>
      </main>
    );
  }
  return (
    <RoomScreen
      api={api}
      onExit={onExit}
      room={room}
      teams={teams}
      updateRoom={setRoom}
    />
  );
}
