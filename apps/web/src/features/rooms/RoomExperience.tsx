import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import { TeamFlag } from "../../components/TeamFlag.js";

import "./rooms.css";

import {
  createInitialSenseDraft,
  createSenseDraftFromSlate,
  isSenseDraftComplete,
  moveSense,
  selectSenseOption,
  senseAllocated,
  toSensePicks,
  type SenseDraft,
} from "./model.js";
import type {
  ReactionType,
  RoomApi,
  RoomExperienceRoute,
  RoomFixture,
  RoomMember,
  RoomTeam,
  RoomView,
  SenseMarket,
} from "./types.js";

export interface RoomExperienceProps {
  readonly api: RoomApi;
  readonly onClose?: () => void;
  readonly onExit?: () => void;
  readonly onOpenMatch?: (fixtureId: string) => void;
  readonly onOpenRoom?: (roomId: string) => void;
  readonly route: RoomExperienceRoute;
}

const REACTIONS: readonly { type: ReactionType; label: string }[] = [
  { type: "roar", label: "ROAR" },
  { type: "cold", label: "COLD" },
  { type: "called_it", label: "CALLED IT" },
];

function teamStyle(team: RoomTeam): CSSProperties {
  return {
    "--msr-team": team.primary,
    "--msr-team-ink": team.foreground ?? "#0b0d0c",
    "--msr-team-secondary": team.secondary,
  } as CSSProperties;
}

function formatKickoff(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Kickoff pending";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(time);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The room could not update.";
}

function initials(name: string) {
  return name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function Header({
  label,
  onExit,
}: {
  label: string;
  onExit: (() => void) | undefined;
}) {
  return (
    <header className="msr-header">
      <span className="msr-wordmark">
        Match<b>Sense</b>
      </span>
      <span className="msr-header-state">{label}</span>
      {onExit ? (
        <button
          aria-label="Close room"
          className="msr-close"
          onClick={onExit}
          type="button"
        >
          <span />
          <span />
        </button>
      ) : null}
    </header>
  );
}

export function PointsNotice() {
  return (
    <aside className="msr-sense-notice">
      <span>100 free Sense each</span>
      <b>FRIEND SENSE · NO MONEY · NO PRIZES</b>
      <small>Not purchasable, transferable, or redeemable.</small>
    </aside>
  );
}

export function FixtureBanner({ fixture }: { fixture: RoomFixture }) {
  return (
    <section
      className="msr-fixture msr-sense-fixture"
      aria-label={`${fixture.homeTeam.name} versus ${fixture.awayTeam.name}`}
    >
      <div className="msr-team-lockup" style={teamStyle(fixture.homeTeam)}>
        <TeamFlag size="standard" team={fixture.homeTeam} />
        <span>{fixture.homeTeam.code}</span>
        <b>{fixture.homeTeam.name}</b>
      </div>
      <div className="msr-fixture-center">
        <strong>V</strong>
        <span>{formatKickoff(fixture.kickoffAt)}</span>
      </div>
      <div
        className="msr-team-lockup is-away"
        style={teamStyle(fixture.awayTeam)}
      >
        <TeamFlag size="standard" team={fixture.awayTeam} />
        <span>{fixture.awayTeam.code}</span>
        <b>{fixture.awayTeam.name}</b>
      </div>
    </section>
  );
}

function DoorForm({
  fixture,
  initialName,
  initialNickname,
  inviteHost,
  busy,
  error,
  onSubmit,
  onExit,
}: {
  fixture: RoomFixture;
  initialName: string;
  initialNickname: string;
  inviteHost?: string;
  busy: boolean;
  error: string | null;
  onSubmit(name: string, nickname: string): void;
  onExit: (() => void) | undefined;
}) {
  const [name, setName] = useState(initialName);
  const [nickname, setNickname] = useState(initialNickname);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(name, nickname);
  };
  return (
    <div
      className="msr-stage msr-stage--door"
      data-room-stage={inviteHost ? "invite" : "create"}
    >
      <Header
        label={inviteHost ? "Room invite" : "Create room"}
        onExit={onExit}
      />
      <div className="msr-title-block">
        <p className="msr-kicker">
          {inviteHost ? `${inviteHost} invited you` : "A private match ritual"}
        </p>
        <h1>
          {inviteHost
            ? "Enter match night."
            : "Put 100 Sense where your instinct is."}
        </h1>
        <p>
          Five calls. Your friends. Picks stay secret until kickoff, then every
          swing lands together.
        </p>
      </div>
      <FixtureBanner fixture={fixture} />
      <PointsNotice />
      <form className="msr-door-form" onSubmit={submit}>
        {!inviteHost ? (
          <label>
            <span>Room name</span>
            <input
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
        ) : null}
        <label>
          <span>Your match-night name</span>
          <input
            maxLength={30}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Abhinav"
            required
            value={nickname}
          />
        </label>
        {error ? (
          <p className="msr-form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="msr-primary-action"
          disabled={busy || !nickname.trim() || !name.trim()}
          type="submit"
        >
          <span>
            {busy
              ? "Opening the room…"
              : inviteHost
                ? "Join & get 100 Sense"
                : "Create private room"}
          </span>
          <i aria-hidden="true">→</i>
        </button>
      </form>
    </div>
  );
}

function MarketCard({
  market,
  draft,
  onMove,
  onSelect,
}: {
  market: SenseMarket;
  draft: SenseDraft;
  onMove(direction: 1 | -1): void;
  onSelect(selection: SenseMarket["selections"][number]["id"]): void;
}) {
  const entry = draft[market.id];
  return (
    <article className="msr-market-card">
      <header>
        <div>
          <span>{market.id.replaceAll("_", " · ")}</span>
          <h3>{market.label}</h3>
        </div>
        <small>{market.sourceLabel}</small>
      </header>
      <div className="msr-market-options">
        {market.selections.map((option) => (
          <button
            className={entry.selection === option.id ? "is-selected" : ""}
            key={option.id}
            onClick={() => onSelect(option.id)}
            type="button"
          >
            <span>{option.label}</span>
            <b>{option.price.toFixed(2)}×</b>
          </button>
        ))}
      </div>
      <footer>
        <span>Conviction</span>
        <div className="msr-sense-stepper">
          <button
            aria-label={`Remove 5 Sense from ${market.label}`}
            disabled={entry.allocation <= 5}
            onClick={() => onMove(-1)}
            type="button"
          >
            −
          </button>
          <strong>
            {entry.allocation}
            <small> Sense</small>
          </strong>
          <button
            aria-label={`Add 5 Sense to ${market.label}`}
            onClick={() => onMove(1)}
            type="button"
          >
            +
          </button>
        </div>
      </footer>
    </article>
  );
}

export function SenseAllocator({
  room,
  busy,
  error,
  onLock,
}: {
  room: RoomView;
  busy: boolean;
  error: string | null;
  onLock(picks: ReturnType<typeof toSensePicks>): void;
}) {
  const [draft, setDraft] = useState(() =>
    room.sense.mySlate
      ? createSenseDraftFromSlate(room.sense.mySlate)
      : createInitialSenseDraft(),
  );
  const complete = isSenseDraftComplete(draft);
  return (
    <section className="msr-sense-board" data-room-stage="picks">
      <header className="msr-sense-board-head">
        <div>
          <p className="msr-kicker">Your private slate</p>
          <h2>Read the match before it happens.</h2>
        </div>
        <div className="msr-sense-wallet">
          <span>Allocated</span>
          <strong>{senseAllocated(draft)} / 100</strong>
        </div>
      </header>
      <p className="msr-secret-note">
        Your exact picks are hidden from everyone else until kickoff.
      </p>
      <div className="msr-market-grid">
        {room.sense.markets.map((market) => (
          <MarketCard
            key={market.id}
            market={market}
            draft={draft}
            onMove={(direction) =>
              setDraft((current) => moveSense(current, market.id, direction))
            }
            onSelect={(selection) =>
              setDraft((current) =>
                selectSenseOption(current, market.id, selection),
              )
            }
          />
        ))}
      </div>
      {error ? (
        <p className="msr-form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="msr-primary-action msr-lock-slate"
        disabled={busy || !complete}
        onClick={() => onLock(toSensePicks(draft))}
        type="button"
      >
        <span>
          {busy
            ? "Locking your calls…"
            : complete
              ? "Lock my 100 Sense"
              : "Choose all five outcomes"}
        </span>
        <i aria-hidden="true">🔒</i>
      </button>
    </section>
  );
}

function Members({ room }: { room: RoomView }) {
  return (
    <section className="msr-member-board">
      <header>
        <h2>In this room</h2>
        <span>{room.members.length} / 20 fans</span>
      </header>
      <ul>
        {room.members.map((member) => (
          <li className="msr-member" key={member.id}>
            <span className="msr-member-mark">{initials(member.nickname)}</span>
            <span className="msr-member-copy">
              <b>
                {member.nickname}
                {member.id === room.viewerMemberId ? " · you" : ""}
              </b>
              <small>
                {member.teamCode ?? "Neutral"} · {member.role}
              </small>
            </span>
            <span className="msr-member-status">
              {member.hasPicks
                ? "Picks locked"
                : room.sense.phase === "DRAFT"
                  ? "In lobby"
                  : "Choosing"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RevealedSlates({ room }: { room: RoomView }) {
  if (room.sense.revealedSlates.length === 0) return null;
  return (
    <section className="msr-revealed">
      <header>
        <p className="msr-kicker">Kickoff reveal</p>
        <h2>Everyone showed their hand.</h2>
      </header>
      <div>
        {room.sense.revealedSlates.map((slate) => {
          const member = room.members.find(
            ({ id }) => id === slate.participantId,
          );
          return (
            <article key={slate.participantId}>
              <h3>{member?.nickname ?? "Fan"}</h3>
              <ul>
                {slate.picks.map((pick) => (
                  <li key={pick.marketId}>
                    <span>{pick.marketId.replaceAll("_", " ")}</span>
                    <b>
                      {pick.selection} · {pick.allocation}S
                    </b>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Reactions({
  room,
  busy,
  onReact,
}: {
  room: RoomView;
  busy: boolean;
  onReact(type: ReactionType, recipient: RoomMember): void;
}) {
  const recipients = room.members.filter(
    ({ id }) => id !== room.viewerMemberId,
  );
  if (!room.currentMoment || recipients.length === 0) return null;
  return (
    <section className="msr-rival-panel">
      <header>
        <span>Poke a rival</span>
        <small>Tied to {room.currentMoment.label}</small>
      </header>
      <div className="msr-rival-row">
        {recipients.map((recipient) => (
          <div key={recipient.id}>
            <b>{recipient.nickname}</b>
            {REACTIONS.map((reaction) => (
              <button
                disabled={busy}
                key={reaction.type}
                onClick={() => onReact(reaction.type, recipient)}
                type="button"
              >
                {reaction.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalLeaderboard({ room }: { room: RoomView }) {
  return (
    <section className="msr-sense-leaderboard" data-room-stage="final">
      <header>
        <p className="msr-kicker">Full-time table</p>
        <h2>Instinct, settled.</h2>
      </header>
      {room.sense.leaderboard.length ? (
        <ol>
          {room.sense.leaderboard.map((row) => (
            <li key={row.memberId}>
              <strong>#{row.rank}</strong>
              <span>
                <b>{row.nickname}</b>
                <small>{row.correctCount} of 5 calls</small>
              </span>
              <em>{row.returnedSense.toFixed(1)} Sense</em>
            </li>
          ))}
        </ol>
      ) : (
        <p>Final stats are being reconciled from TxLINE.</p>
      )}
    </section>
  );
}

function RoomScreen({
  room,
  busy,
  error,
  notice,
  onExit,
  onOpenMatch,
  onOpenPicks,
  onStartExperience,
  onSavePicks,
  onShare,
  onReact,
}: {
  room: RoomView;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onExit: (() => void) | undefined;
  onOpenMatch: (() => void) | undefined;
  onOpenPicks(): void;
  onStartExperience(): void;
  onSavePicks(picks: ReturnType<typeof toSensePicks>): void;
  onShare(): void;
  onReact(type: ReactionType, recipient: RoomMember): void;
}) {
  const viewer = room.members.find(({ id }) => id === room.viewerMemberId);
  const canPick =
    viewer?.role !== "spectator" &&
    room.sense.phase === "OPEN" &&
    !room.sense.mySlate;
  return (
    <div
      className={`msr-stage msr-stage--sense is-${room.sense.phase.toLowerCase()}`}
      data-room-stage={room.sense.phase.toLowerCase()}
    >
      <Header label={room.sense.phase} onExit={onExit} />
      <div className="msr-title-block">
        <p className="msr-kicker">{room.name}</p>
        <h1>
          {room.sense.phase === "FINAL"
            ? "The room has spoken."
            : room.sense.phase === "LIVE"
              ? "Every call is alive."
              : "Your match. Your people. Your read."}
        </h1>
      </div>
      <FixtureBanner fixture={room.fixture} />
      <PointsNotice />
      {room.currentMoment ? (
        <section className={`msr-room-moment is-${room.currentMoment.state}`}>
          <span>{room.currentMoment.minute}</span>
          <div>
            <p>
              {room.currentMoment.state === "review"
                ? "UNDER REVIEW"
                : room.currentMoment.label}
            </p>
            <strong>
              {room.currentMoment.score.home}—{room.currentMoment.score.away}
            </strong>
          </div>
        </section>
      ) : null}
      {error ? (
        <p className="msr-form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="msr-room-notice" role="status">
          {notice}
        </p>
      ) : null}
      {room.sense.phase === "DRAFT" ? (
        <section className="msr-host-gate">
          <h2>
            {room.isHost
              ? "Bring everyone in, then open the board."
              : "The host is gathering the room."}
          </h2>
          <p>Picks open for everyone at once. Exact allocations stay secret.</p>
          <div>
            {room.inviteUrl ? (
              <button onClick={onShare} type="button">
                Share private invite
              </button>
            ) : null}
            {room.isHost ? (
              <button
                className="is-primary"
                disabled={busy}
                onClick={onOpenPicks}
                type="button"
              >
                Open 100-Sense picks
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      {canPick ? (
        <SenseAllocator
          busy={busy}
          error={error}
          onLock={onSavePicks}
          room={room}
        />
      ) : null}
      {room.sense.phase === "OPEN" && room.sense.mySlate ? (
        <section className="msr-locked-note">
          <span>100 / 100 allocated</span>
          <h2>Your slate is sealed.</h2>
          <p>
            Friends can see that you locked in, but not what you chose. Picks
            reveal automatically at kickoff.
          </p>
        </section>
      ) : null}
      {room.fixture.isReplay && room.isHost && room.sense.phase === "OPEN" ? (
        <section className="msr-host-gate msr-experience-gate">
          <h2>Everyone ready? Start the Experience.</h2>
          <p>
            This locks the room and reveals every submitted slate. The match
            itself continues in the main Live Companion.
          </p>
          <div>
            <button
              className="is-primary"
              disabled={busy}
              onClick={onStartExperience}
              type="button"
            >
              Start Experience
            </button>
          </div>
        </section>
      ) : null}
      {room.sense.phase === "LOCKED" ? (
        <section className="msr-kickoff-hold">
          <span>🔒 KICKOFF</span>
          <h2>No edits. No hiding.</h2>
          <p>
            Every slate is now visible. Live scoring starts with the first
            TxLINE update.
          </p>
        </section>
      ) : null}
      <RevealedSlates room={room} />
      {room.sense.phase === "FINAL" ? <FinalLeaderboard room={room} /> : null}
      <Reactions busy={busy} onReact={onReact} room={room} />
      <Members room={room} />
      {onOpenMatch ? (
        <button
          className="msr-secondary-action"
          onClick={onOpenMatch}
          type="button"
        >
          Open Live Companion
        </button>
      ) : null}
    </div>
  );
}

export function RoomExperience({
  api,
  onClose,
  onExit,
  onOpenMatch,
  onOpenRoom,
  route,
}: RoomExperienceProps) {
  const exit = onExit ?? onClose;
  const [room, setRoom] = useState<RoomView | null>(() =>
    route.mode === "room" ? (route.initialRoom ?? null) : null,
  );
  const [preview, setPreview] = useState(() =>
    route.mode === "invite" ? (route.preview ?? null) : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(
    route.mode === "room" && !route.initialRoom,
  );

  useEffect(() => {
    let active = true;
    if (route.mode === "room" && !route.initialRoom) {
      setLoading(true);
      api
        .getRoom(route.roomId)
        .then((next) => {
          if (active) {
            setRoom(next);
            setLoading(false);
          }
        })
        .catch((cause) => {
          if (active) {
            setError(errorText(cause));
            setLoading(false);
          }
        });
    }
    if (route.mode === "invite" && !route.preview) {
      api
        .previewInvite(route.inviteCode)
        .then((next) => {
          if (active) setPreview(next);
        })
        .catch((cause) => {
          if (active) setError(errorText(cause));
        });
    }
    return () => {
      active = false;
    };
  }, [api, route]);

  useEffect(() => {
    if (!room) return;
    return api.subscribeRoom(room.id, room.viewerMemberId, setRoom, (cause) =>
      setNotice(cause.message),
    );
  }, [api, room?.id, room?.viewerMemberId]);

  const act = async (work: () => Promise<RoomView>, success?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await work();
      setRoom(next);
      if (success) setNotice(success);
      return next;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const create = async (name: string, nickname: string) => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createRoom({
        fixtureId: route.mode === "create" ? route.fixture.id : "",
        name,
        nickname,
      });
      setRoom(created.room);
      onOpenRoom?.(created.room.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const join = async (_name: string, nickname: string) => {
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
      onOpenRoom?.(joined.room.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    if (!room?.inviteUrl) return;
    try {
      if (navigator.share)
        await navigator.share({
          title: room.name,
          text: `Join my ${room.fixture.homeTeam.name} vs ${room.fixture.awayTeam.name} MatchSense room`,
          url: room.inviteUrl,
        });
      else await navigator.clipboard.writeText(room.inviteUrl);
      setNotice("Private invite ready to send.");
    } catch {
      setNotice("Invite sharing was cancelled.");
    }
  };

  if (route.mode === "create" && !room)
    return (
      <DoorForm
        busy={busy}
        error={error}
        fixture={route.fixture}
        initialName={route.defaultRoomName ?? "Match Night"}
        initialNickname={route.defaultNickname ?? ""}
        onExit={exit}
        onSubmit={create}
      />
    );
  if (route.mode === "invite" && !room) {
    if (!preview)
      return (
        <div className="msr-stage msr-stage--loading" data-room-stage="loading">
          <Header label="Opening invite" onExit={exit} />
          <h1>{error ?? "Getting the room ready…"}</h1>
        </div>
      );
    return (
      <DoorForm
        busy={busy}
        error={error}
        fixture={preview.fixture}
        initialName={preview.roomName}
        initialNickname={route.defaultNickname ?? ""}
        inviteHost={preview.hostNickname}
        onExit={exit}
        onSubmit={join}
      />
    );
  }
  if (loading || !room)
    return (
      <div className="msr-stage msr-stage--loading" data-room-stage="loading">
        <Header label="Private room" onExit={exit} />
        <h1>{error ?? "Opening match night…"}</h1>
      </div>
    );

  return (
    <RoomScreen
      busy={busy}
      error={error}
      notice={notice}
      onExit={exit}
      onOpenMatch={onOpenMatch ? () => onOpenMatch(room.fixture.id) : undefined}
      onOpenPicks={() =>
        void act(() => api.openPicks(room.id), "Picks are open for everyone.")
      }
      onStartExperience={() =>
        void act(
          () => api.startExperience(room.id),
          "Experience started. Every submitted slate is now visible.",
        )
      }
      onReact={(type, recipient) => {
        if (!room.currentMoment) return;
        void act(
          async () =>
            (
              await api.sendReaction(room.id, {
                momentId: room.currentMoment!.momentId,
                momentRevision: room.currentMoment!.revision,
                recipientMemberId: recipient.id,
                type,
              })
            ).room,
          `${type.replace("_", " ").toUpperCase()} sent to ${recipient.nickname}.`,
        );
      }}
      onSavePicks={(picks) =>
        void act(
          () => api.savePicks(room.id, picks),
          "Your 100 Sense are locked.",
        )
      }
      onShare={() => void share()}
      room={room}
    />
  );
}
