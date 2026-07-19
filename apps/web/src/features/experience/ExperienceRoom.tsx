import { useEffect, useMemo, useState } from "react";

import { TeamFlag } from "../../components/TeamFlag.js";
import type { ProductCatalog } from "../../live-api.js";
import {
  enableMomentPush,
  triggerTestMomentPush,
} from "../../push-notifications.js";
import {
  createExperienceRoomApi,
  type ExperienceCall,
  type ExperienceRoomApi,
  type ExperienceRoomPreview,
  type ExperienceRoomView,
} from "./experience-room-api.js";
import "./experience.css";

type Route =
  | { awayTeam: string; homeTeam: string; mode: "create" }
  | { inviteCode: string; mode: "invite" }
  | { mode: "room"; roomId: string };

const DEFAULT_CALLS: readonly ExperienceCall[] = [
  { answer: "HOME", confidence: 3, target: "result" },
  { answer: "YES", confidence: 2, target: "goals" },
  { answer: "YES", confidence: 1, target: "cards" },
];

function remaining(deadline: number, now: number) {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Team({ catalog, code }: { catalog: ProductCatalog; code: string }) {
  const team = catalog.teams.find((entry) => entry.code === code);
  return team ? (
    <div className="ms-ex-room-team">
      <TeamFlag size="standard" team={team} />
      <strong>{team.name}</strong>
      <span>{team.code}</span>
    </div>
  ) : (
    <strong>{code}</strong>
  );
}

function Calls({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange(calls: readonly ExperienceCall[]): void;
  value: readonly ExperienceCall[];
}) {
  const update = (
    target: ExperienceCall["target"],
    patch: Partial<ExperienceCall>,
  ) => {
    const previous = value.find((call) => call.target === target)!;
    onChange(
      value.map((call) => {
        if (call.target === target) {
          return { ...call, ...patch } as ExperienceCall;
        }
        if (
          patch.confidence &&
          call.confidence === patch.confidence &&
          call.target !== target
        ) {
          return { ...call, confidence: previous.confidence } as ExperienceCall;
        }
        return call;
      }),
    );
  };
  const row = (
    target: ExperienceCall["target"],
    title: string,
    choices: readonly { label: string; value: string }[],
  ) => {
    const call = value.find((entry) => entry.target === target)!;
    return (
      <fieldset className="ms-ex-call" disabled={disabled}>
        <legend>{title}</legend>
        <div className="ms-ex-call__answers">
          {choices.map((choice) => (
            <button
              className={call.answer === choice.value ? "is-selected" : ""}
              key={choice.value}
              onClick={() =>
                update(target, {
                  answer: choice.value,
                } as Partial<ExperienceCall>)
              }
              type="button"
            >
              {choice.label}
            </button>
          ))}
        </div>
        <label>
          Confidence
          <select
            onChange={(event) =>
              update(target, {
                confidence: Number(event.target.value) as 1 | 2 | 3,
              })
            }
            value={call.confidence}
          >
            <option value="1">1 · 100 pts</option>
            <option value="2">2 · 200 pts</option>
            <option value="3">3 · 300 pts</option>
          </select>
        </label>
      </fieldset>
    );
  };
  return (
    <div className="ms-ex-calls">
      {row("result", "Who wins in regulation?", [
        { label: "Home", value: "HOME" },
        { label: "Draw", value: "DRAW" },
        { label: "Away", value: "AWAY" },
      ])}
      {row("goals", "Three or more total goals?", [
        { label: "Yes", value: "YES" },
        { label: "No", value: "NO" },
      ])}
      {row("cards", "Five or more total cards?", [
        { label: "Yes", value: "YES" },
        { label: "No", value: "NO" },
      ])}
    </div>
  );
}

export function ExperienceRoom({
  api,
  catalog,
  favoriteTeam,
  nickname,
  onBack,
  onOpenMatch,
  onOpenRoom,
  route,
}: {
  api?: ExperienceRoomApi;
  catalog: ProductCatalog;
  favoriteTeam: string | null;
  nickname: string;
  onBack(): void;
  onOpenMatch(runId: string): void;
  onOpenRoom(roomId: string): void;
  route: Route;
}) {
  const client = useMemo(() => api ?? createExperienceRoomApi(), [api]);
  const [room, setRoom] = useState<ExperienceRoomView | null>(null);
  const [preview, setPreview] = useState<ExperienceRoomPreview | null>(null);
  const [name, setName] = useState(`${nickname}'s Match Night`);
  const [calls, setCalls] = useState<readonly ExperienceCall[]>(DEFAULT_CALLS);
  const [supporters, setSupporters] = useState(true);
  const [busy, setBusy] = useState(false);
  const [alerts, setAlerts] = useState<
    "idle" | "enabling" | "enabled" | "unavailable"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (route.mode === "create") return;
    let active = true;
    const load =
      route.mode === "invite"
        ? client.preview(route.inviteCode).then((value) => {
            if (active) setPreview(value);
          })
        : client.get(route.roomId).then((value) => {
            if (active) setRoom(value);
          });
    void load.catch((reason: unknown) => {
      if (active)
        setError(reason instanceof Error ? reason.message : "Room unavailable");
    });
    return () => {
      active = false;
    };
  }, [client, route]);

  useEffect(() => {
    if (!room) return;
    const stream = client.stream(room.id, setRoom);
    return () => stream.close();
  }, [client, room?.id]);

  const act = async (action: () => Promise<ExperienceRoomView>) => {
    setBusy(true);
    setError(null);
    try {
      setRoom(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Action unavailable");
    } finally {
      setBusy(false);
    }
  };

  const enableAlerts = async () => {
    setAlerts("enabling");
    try {
      const response = await fetch("/api/v1/push/config");
      const config = response.ok
        ? ((await response.json()) as {
            applicationServerKey?: unknown;
            supported?: unknown;
          })
        : null;
      if (
        config?.supported !== true ||
        typeof config.applicationServerKey !== "string"
      ) {
        throw new Error("Push unavailable");
      }
      const registration = await enableMomentPush({
        applicationServerKey: config.applicationServerKey,
      });
      if (room) {
        await triggerTestMomentPush(registration.id, {
          body: "Your Room alerts are ready. Match facts will arrive here while the PWA is closed.",
          familyId: "readiness",
          fixtureId: `experience:${room.experience.runId}`,
          momentId: "readiness",
          occurredAt: new Date().toISOString(),
          revision: 1,
          title: "EXPERIENCE ROOM — Alerts ready",
        });
      }
      setAlerts("enabled");
    } catch {
      setAlerts("unavailable");
    }
  };

  if (route.mode === "create" && !room) {
    const home = route.homeTeam;
    const away = route.awayTeam;
    return (
      <main className="ms-experience ms-ex-room" id="main-content">
        <header className="ms-experience__masthead">
          <button onClick={onBack} type="button">
            Experience
          </button>
          <span>EXPERIENCE ROOM · POINTS ONLY</span>
        </header>
        <section className="ms-ex-room-create">
          <div>
            <p>YOUR FIVE-MINUTE WATCH PARTY</p>
            <h1>Call it before the whistle.</h1>
            <span>
              Invite a second device, make three calls, lock them, then feel the
              same canonical match together.
            </span>
          </div>
          <div className="ms-ex-room-create__fixture">
            <Team catalog={catalog} code={home} />
            <i>VS</i>
            <Team catalog={catalog} code={away} />
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              void client
                .create({
                  addDemoSupporters: supporters,
                  awayTeam: away,
                  homeTeam: home,
                  name,
                  nickname,
                  teamCode: favoriteTeam,
                })
                .then((created) => {
                  sessionStorage.setItem(
                    `matchsense-experience-invite:${created.room.id}`,
                    created.invitePath,
                  );
                  onOpenRoom(created.room.id);
                })
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Room unavailable",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            <label>
              Room name
              <input
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </label>
            <label className="ms-ex-room-check">
              <input
                checked={supporters}
                onChange={(event) => setSupporters(event.target.checked)}
                type="checkbox"
              />
              <span>Add Maya and Leo as demo supporters</span>
            </label>
            <button disabled={busy} type="submit">
              {busy ? "Building the room" : "Create room and invite"}
            </button>
          </form>
        </section>
        {error ? (
          <p className="ms-experience-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
    );
  }

  if (route.mode === "invite" && !room) {
    return (
      <main className="ms-experience ms-ex-room" id="main-content">
        <header className="ms-experience__masthead">
          <button onClick={onBack} type="button">
            MatchSense
          </button>
          <span>FRIEND INVITE</span>
        </header>
        <section className="ms-ex-room-invite">
          <p>YOU HAVE BEEN CALLED IN</p>
          <h1>{preview?.name ?? "Opening the room"}</h1>
          {preview ? (
            <>
              <div className="ms-ex-room-create__fixture">
                <Team catalog={catalog} code={preview.fixture.homeTeam} />
                <i>VS</i>
                <Team catalog={catalog} code={preview.fixture.awayTeam} />
              </div>
              <p>
                {preview.hostNickname} invited you · {preview.memberCount}{" "}
                already inside
              </p>
            </>
          ) : null}
          <button
            disabled={!preview || busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void client
                .join({
                  inviteCode: route.inviteCode,
                  nickname,
                  teamCode: favoriteTeam,
                })
                .then((joined) => onOpenRoom(joined.id))
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "You could not join this room",
                  ),
                )
                .finally(() => setBusy(false));
            }}
            type="button"
          >
            Join and make my calls
          </button>
        </section>
        {error ? (
          <p className="ms-experience-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
    );
  }

  if (!room)
    return (
      <main className="ms-experience ms-experience--loading" id="main-content">
        <span />
        <p>{error ?? "Opening the room"}</p>
        <button onClick={onBack} type="button">
          Back
        </button>
      </main>
    );

  const me = room.members.find(
    (member) => member.id === room.viewerParticipantId,
  );
  const host = room.viewerParticipantId === room.hostParticipantId;
  const allLocked = room.members
    .filter((member) => member.role === "PLAYER")
    .every((member) => member.lockedAt);
  const sharePath = sessionStorage.getItem(
    `matchsense-experience-invite:${room.id}`,
  );
  const otherMembers = room.members.filter(
    (member) => member.id !== room.viewerParticipantId,
  );

  return (
    <main className="ms-experience ms-ex-room" id="main-content">
      <header className="ms-experience__masthead">
        <button onClick={onBack} type="button">
          Experience
        </button>
        <span>{room.experience.label}</span>
      </header>
      <section className="ms-ex-room-hero">
        <div>
          <p>
            {room.status === "PRE_KICKOFF"
              ? "CALLS LOCK AT THE WHISTLE"
              : room.status === "LIVE"
                ? `${room.fixture.minute} · LIVE TOGETHER`
                : "FINAL ROOM TABLE"}
          </p>
          <h1>{room.name}</h1>
          <span>{room.friendPointsLabel}</span>
        </div>
        <div className="ms-ex-room-score">
          <Team catalog={catalog} code={room.fixture.homeTeam} />
          <strong>
            {room.fixture.score?.home ?? 0}
            <i>—</i>
            {room.fixture.score?.away ?? 0}
          </strong>
          <Team catalog={catalog} code={room.fixture.awayTeam} />
        </div>
      </section>

      {room.status === "PRE_KICKOFF" ? (
        <section className="ms-ex-room-lobby">
          <article className="ms-ex-room-lobby__people">
            <header>
              <div>
                <p>ROOM LOBBY</p>
                <h2>
                  Kickoff in {remaining(room.experience.lobbyDeadlineAt, now)}
                </h2>
              </div>
              {sharePath ? (
                <button
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      new URL(sharePath, window.location.origin).toString(),
                    )
                  }
                  type="button"
                >
                  Copy invite link
                </button>
              ) : null}
            </header>
            <button
              className="ms-ex-room-alerts"
              disabled={alerts === "enabling" || alerts === "enabled"}
              onClick={() => void enableAlerts()}
              type="button"
            >
              {alerts === "enabled"
                ? "Lock-screen alerts enabled"
                : alerts === "enabling"
                  ? "Enabling alerts"
                  : alerts === "unavailable"
                    ? "Alerts unavailable on this device"
                    : "Enable lock-screen match alerts"}
            </button>
            <div>
              {room.members.map((member) => (
                <div className="ms-ex-member" key={member.id}>
                  <span data-team={member.teamCode ?? ""}>
                    {member.nickname.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <b>
                      {member.nickname}
                      {member.isHost ? " · HOST" : ""}
                    </b>
                    <small>
                      {member.isDemoSupporter
                        ? "DEMO SUPPORTER"
                        : member.lockedAt
                          ? "CALLS LOCKED"
                          : member.hasCalls
                            ? "CALLS SAVED"
                            : "MAKING CALLS"}
                    </small>
                  </div>
                  <i className={member.lockedAt ? "is-ready" : ""} />
                </div>
              ))}
            </div>
          </article>
          <article className="ms-ex-room-lobby__calls">
            <header>
              <p>CALL THREE</p>
              <h2>Your match instincts</h2>
              <span>Assign confidence 1, 2 and 3 once each.</span>
            </header>
            <Calls
              disabled={Boolean(me?.lockedAt)}
              onChange={setCalls}
              value={calls}
            />
            <div className="ms-ex-room-actions">
              <button
                disabled={busy || Boolean(me?.lockedAt)}
                onClick={() => void act(() => client.saveCalls(room.id, calls))}
                type="button"
              >
                Save calls
              </button>
              <button
                disabled={busy || !room.myCalls || Boolean(me?.lockedAt)}
                onClick={() => void act(() => client.lock(room.id))}
                type="button"
              >
                {me?.lockedAt ? "Calls locked" : "Lock my calls"}
              </button>
              {host ? (
                <button
                  className="is-primary"
                  disabled={busy || !allLocked}
                  onClick={() => void act(() => client.start(room.id))}
                  type="button"
                >
                  Start when everyone is ready
                </button>
              ) : null}
            </div>
          </article>
        </section>
      ) : (
        <section className="ms-ex-room-live">
          <article>
            <p>
              {room.status === "FINAL"
                ? "FINAL STANDINGS"
                : "PROVISIONAL TABLE"}
            </p>
            <h2>Who called it?</h2>
            <div className="ms-ex-leaderboard">
              {room.leaderboard.map((entry) => (
                <div key={entry.participantId}>
                  <b>{entry.rank}</b>
                  <span>
                    {entry.nickname}
                    <small>
                      {entry.correctCalls} correct ·{" "}
                      {entry.provisional ? "provisional" : "final"}
                    </small>
                  </span>
                  <strong>{entry.score}</strong>
                </div>
              ))}
            </div>
          </article>
          <article>
            <p>MATCH TOGETHER</p>
            <h2>
              {room.currentMoment
                ? `Moment ${room.currentMoment.momentId}`
                : "Waiting for the next moment"}
            </h2>
            {room.status === "LIVE" ? (
              <button
                className="is-primary"
                onClick={() => onOpenMatch(room.experience.runId)}
                type="button"
              >
                Open live companion and Pocket Listening
              </button>
            ) : (
              <button
                className="is-primary"
                onClick={() => onOpenMatch(room.experience.runId)}
                type="button"
              >
                Open Match Memory
              </button>
            )}
            {room.currentMoment && room.currentMoment.varState !== "HOLD" ? (
              <div className="ms-ex-reactions">
                {otherMembers.slice(0, 3).map((member) => (
                  <button
                    disabled={busy}
                    key={member.id}
                    onClick={() =>
                      void act(() =>
                        client.react(room.id, {
                          kind: "ROAR",
                          momentId: room.currentMoment!.momentId,
                          recipientParticipantId: member.id,
                          revision: room.currentMoment!.revision,
                        }),
                      )
                    }
                    type="button"
                  >
                    Roar at {member.nickname}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="ms-ex-reaction-feed">
              {room.reactions
                .slice(-4)
                .reverse()
                .map((reaction) => (
                  <p key={reaction.id}>
                    <b>{reaction.senderNickname}</b> sent{" "}
                    {reaction.kind.toLowerCase()} to{" "}
                    {reaction.recipientNickname}
                    {reaction.status === "OVERTURNED" ? " · overturned" : ""}
                  </p>
                ))}
            </div>
          </article>
        </section>
      )}
      {error ? (
        <p className="ms-experience-error" role="alert">
          {error}
        </p>
      ) : null}
      {route.mode === "create" && room ? (
        <button
          className="ms-ex-room-route"
          onClick={() => onOpenRoom(room.id)}
          type="button"
        >
          Keep this room at its own shareable route
        </button>
      ) : null}
    </main>
  );
}
