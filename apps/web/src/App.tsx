import {
  type CSSProperties,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { ListeningProvider, useListening } from "./ListeningProvider.js";
import {
  type CanonicalEventPayload,
  type CommentaryEventPayload,
  createInitialLiveState,
  formatFreshness,
  type LiveCommentary,
  type LiveMoment,
  type LiveSnapshot,
  liveViewReducer,
  normalizePath,
  type TeamCode,
} from "./product-state.js";

const teams: Array<{ code: TeamCode; name: string; note: string }> = [
  { code: "ARG", name: "Argentina", note: "Sky, paper, and match-night blue" },
  { code: "BRA", name: "Brazil", note: "Canopy green and tournament gold" },
  { code: "ESP", name: "Spain", note: "Signal red and tournament gold" },
  { code: "FRA", name: "France", note: "Deep blue and signal red" },
  { code: "JPN", name: "Japan", note: "Paper white and rising sun red" },
];

const opponents: Record<TeamCode, TeamCode> = {
  ARG: "FRA",
  BRA: "JPN",
  ESP: "FRA",
  FRA: "ARG",
  JPN: "BRA",
};

function teamName(code: TeamCode) {
  return teams.find((team) => team.code === code)?.name ?? code;
}

export interface AppProps {
  initialFavoriteTeam?: TeamCode | null;
  initialPath?: string;
}

function storedFavorite(): TeamCode | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem("matchsense.favoriteTeam");
  return teams.some(({ code }) => code === stored)
    ? (stored as TeamCode)
    : null;
}

function browserPath() {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

export function App(props: AppProps = {}) {
  return (
    <ListeningProvider>
      <ProductApp {...props} />
    </ListeningProvider>
  );
}

function ProductApp({ initialFavoriteTeam, initialPath }: AppProps) {
  const [favoriteTeam, setFavoriteTeam] = useState<TeamCode | null>(() =>
    initialFavoriteTeam === undefined ? storedFavorite() : initialFavoriteTeam,
  );
  const [onboardingStage, setOnboardingStage] = useState<
    "pick" | "moment" | "done"
  >(favoriteTeam ? "done" : "pick");
  const [path, setPath] = useState(() =>
    normalizePath(initialPath ?? browserPath()),
  );

  useEffect(() => {
    const onPopState = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (next: string) => {
    if (typeof window !== "undefined") window.history.pushState({}, "", next);
    setPath(normalizePath(next));
  };

  const pickTeam = (team: TeamCode) => {
    setFavoriteTeam(team);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("matchsense.favoriteTeam", team);
    }
    setOnboardingStage("moment");
  };

  useEffect(() => {
    if (onboardingStage !== "moment") return;
    const timer = window.setTimeout(() => {
      setOnboardingStage("done");
      navigate("/");
    }, 4_800);
    return () => window.clearTimeout(timer);
  }, [onboardingStage]);

  if (!favoriteTeam || onboardingStage === "pick") {
    return <TeamPick onPick={pickTeam} />;
  }
  if (onboardingStage === "moment") {
    return (
      <SampleMoment
        team={favoriteTeam}
        onContinue={() => setOnboardingStage("done")}
      />
    );
  }
  const liveMatch = path.match(/^\/matches\/([^/]+)\/live$/u);
  if (liveMatch?.[1]) {
    return (
      <LiveCompanion
        favoriteTeam={favoriteTeam}
        fixtureId={liveMatch[1]}
        onBack={() => navigate("/")}
      />
    );
  }
  return (
    <Today
      favoriteTeam={favoriteTeam}
      onOpen={(fixtureId) => navigate(`/matches/${fixtureId}/live`)}
    />
  );
}

function Masthead({ end }: { end: string }) {
  return (
    <header className="masthead">
      <a className="wordmark" href="/" aria-label="MatchSense home">
        Match<span>Sense</span>
      </a>
      <span className="mast-status">
        <i />
        {end}
      </span>
    </header>
  );
}

function TeamPick({ onPick }: { onPick(team: TeamCode): void }) {
  const [query, setQuery] = useState("");
  const filtered = teams.filter(({ code, name }) =>
    `${code} ${name}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <main className="onboarding-shell" id="main-content">
      <Masthead end="Setup · 1 of 2" />
      <section className="team-pick-grid">
        <div className="onboarding-copy">
          <p className="kicker">Make the match yours</p>
          <h1>Who do you support?</h1>
          <p>
            Your answer changes color, sound, and emphasis. It never changes the
            score.
          </p>
          <label className="team-search">
            <span>Search the tournament</span>
            <input
              aria-label="Search teams"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Type a team or code"
            />
          </label>
        </div>
        <div className="team-field" role="list" aria-label="Available teams">
          {filtered.map((team, index) => (
            <button
              className="team-choice"
              key={team.code}
              onClick={() => onPick(team.code)}
              style={{ "--order": index } as CSSProperties}
              type="button"
            >
              <Flag code={team.code} large />
              <span>
                <small>{team.code}</small>
                <b>{team.name}</b>
                <em>{team.note}</em>
              </span>
              <ArrowIcon />
            </button>
          ))}
          {filtered.length === 0 ? (
            <p className="empty-state">
              No team matches that search. Try its three-letter code.
            </p>
          ) : null}
        </div>
      </section>
      <Provenance />
    </main>
  );
}

export function SampleMoment({
  team,
  onContinue,
}: {
  team: TeamCode;
  onContinue(): void;
}) {
  const supportedTeamName = teamName(team);
  const opponent = opponents[team];
  const opponentName = teamName(opponent);
  return (
    <main
      className={`sample-moment theme-${team.toLowerCase()}`}
      id="main-content"
    >
      <div className="moment-truth-rail">
        <span>Goal · confirmed</span>
        <b>
          {team} 1—0 {opponent}
        </b>
        <span>23′ · revision 1</span>
      </div>
      <div className="moment-stage" aria-live="polite">
        <div className="textile-plane" aria-hidden="true">
          <Flag code={team} large />
        </div>
        <p className="moment-word">GOAL</p>
        <div className="moment-copy">
          <p className="kicker">Replay sample</p>
          <h1>
            {supportedTeamName} take the lead against {opponentName}.
          </h1>
          <p>
            That is how every important moment will arrive: truth first, then
            atmosphere.
          </p>
        </div>
      </div>
      <div className="moment-footer">
        <span>SIMULATION · TXLINE-SHAPED DATA</span>
        <button className="quiet-button" type="button" onClick={onContinue}>
          Continue now <ArrowIcon />
        </button>
      </div>
    </main>
  );
}

function Today({
  favoriteTeam,
  onOpen,
}: {
  favoriteTeam: TeamCode;
  onOpen(fixtureId: string): void;
}) {
  const [fixture, setFixture] = useState<LiveSnapshot>(
    () => createInitialLiveState().snapshot,
  );
  useEffect(() => {
    let active = true;
    fetch("/api/v1/fixtures")
      .then(async (response) => {
        if (!response.ok) throw new Error("Fixture catalog unavailable");
        return (await response.json()) as { fixtures: LiveSnapshot[] };
      })
      .then(({ fixtures }) => {
        if (active && fixtures[0]) setFixture(fixtures[0]);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const kickoff = fixture.kickoffAt
    ? new Date(fixture.kickoffAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Matchday";
  return (
    <main className="app-canvas" id="main-content">
      <Masthead end={fixture.sourceLabel ?? "Match feed ready"} />
      <section className="today-hero">
        <div>
          <p className="kicker">Thursday · Your matchday</p>
          <h1>Stay in the match while life keeps moving.</h1>
        </div>
        <div className="today-ticket-stamp" aria-hidden="true">
          <span>Following</span>
          <b>{favoriteTeam}</b>
          <small>Ambient match companion</small>
        </div>
      </section>
      <section className="fixture-programme" aria-labelledby="today-fixture">
        <div className="fixture-meta">
          <span>
            {kickoff} · {fixture.sourceLabel ?? "MatchSense source"}
          </span>
          <span>World Cup · {fixture.fixtureId}</span>
        </div>
        <div className="fixture-teams">
          <div>
            <Flag code={fixture.homeTeam} large />
            <span>
              <small>{fixture.homeTeam}</small>
              <b>{teamName(fixture.homeTeam)}</b>
            </span>
          </div>
          <span className="fixture-versus">V</span>
          <div>
            <span>
              <small>{fixture.awayTeam}</small>
              <b>{teamName(fixture.awayTeam)}</b>
            </span>
            <Flag code={fixture.awayTeam} large />
          </div>
        </div>
        <div className="fixture-action">
          <span>
            <i />
            {fixture.provenance === "live_txline"
              ? "TxLINE source · reconciled"
              : "Replay environment · ready"}
          </span>
          <button type="button" onClick={() => onOpen(fixture.fixtureId)}>
            Open match companion <ArrowIcon />
          </button>
        </div>
      </section>
      <section className="today-notes">
        <p>
          <b>One tap to listen.</b> The audio channel stays mounted while you
          move around MatchSense.
        </p>
        <p>
          <b>One canonical score.</b> Every animation and tone follows the same
          revision-linked event.
        </p>
      </section>
      <Provenance label={fixture.sourceLabel} />
    </main>
  );
}

function LiveCompanion({
  fixtureId,
  favoriteTeam,
  onBack,
}: {
  fixtureId: string;
  favoriteTeam: TeamCode;
  onBack(): void;
}) {
  const [state, dispatch] = useReducer(
    liveViewReducer,
    undefined,
    createInitialLiveState,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPlayingDemo, setIsPlayingDemo] = useState(false);
  const [freshnessNow, setFreshnessNow] = useState(() =>
    new Date().toISOString(),
  );
  const replaySession = useRef<string | null>(null);
  const listening = useListening();

  useEffect(() => {
    void listening.prepare(fixtureId, favoriteTeam);
    return () => listening.releasePreparation(fixtureId, favoriteTeam);
  }, [
    favoriteTeam,
    fixtureId,
    listening.prepare,
    listening.releasePreparation,
  ]);

  useEffect(() => {
    const interval = window.setInterval(
      () => setFreshnessNow(new Date().toISOString()),
      1_000,
    );
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/api/v1/fixtures/${fixtureId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Fixture is unavailable");
        return (await response.json()) as LiveSnapshot;
      })
      .then((snapshot) => active && dispatch({ snapshot, type: "snapshot" }))
      .catch(() => active && setError("Could not load the current score."));

    const stream = new EventSource(`/api/v1/fixtures/${fixtureId}/stream`);
    const onSnapshot = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as { snapshot: LiveSnapshot };
      dispatch({ snapshot: payload.snapshot, type: "snapshot" });
    };
    const onMoment = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as CanonicalEventPayload;
      dispatch({ payload, type: "canonical_event" });
      window.setTimeout(
        () => dispatch({ identity: payload.id, type: "open_moment" }),
        60,
      );
    };
    const onCommentary = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as CommentaryEventPayload;
      dispatch({ payload, type: "commentary_ready" });
    };
    stream.addEventListener("snapshot", onSnapshot as EventListener);
    stream.addEventListener("moment.created", onMoment as EventListener);
    stream.addEventListener("moment.revised", onMoment as EventListener);
    stream.addEventListener("commentary.ready", onCommentary as EventListener);
    stream.onopen = () =>
      dispatch({ transportHealth: "reconciled", type: "transport" });
    stream.onerror = () =>
      dispatch({ transportHealth: "stale", type: "transport" });
    return () => {
      active = false;
      stream.close();
    };
  }, [fixtureId]);

  const playGoal = async () => {
    setIsPlayingDemo(true);
    setError(null);
    try {
      if (!replaySession.current) {
        const response = await fetch("/api/v1/replay/sessions", {
          body: JSON.stringify({ fixtureId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!response.ok) throw new Error("Replay session failed");
        replaySession.current = ((await response.json()) as { id: string }).id;
      }
      const response = await fetch(
        `/api/v1/replay/sessions/${replaySession.current}/commands`,
        {
          body: JSON.stringify({
            listeningSessionId: listening.sessionId,
            marker: "goal",
            type: "advance_to_marker",
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) throw new Error("Replay command failed");
      const result = (await response.json()) as {
        accepted: boolean;
        moment?: LiveMoment;
        snapshot?: LiveSnapshot;
      };
      if (result.accepted && result.moment && result.snapshot) {
        const payload: CanonicalEventPayload = {
          event: "moment.created",
          id: result.moment.identity,
          moment: result.moment,
          snapshot: result.snapshot,
        };
        dispatch({ payload, type: "canonical_event" });
        window.setTimeout(
          () => dispatch({ identity: payload.id, type: "open_moment" }),
          60,
        );
      }
    } catch {
      setError("The replay could not advance. Try once more.");
    } finally {
      setIsPlayingDemo(false);
    }
  };

  const relation =
    state.openMoment?.eventTeam === favoriteTeam ? "for" : "neutral";
  const sourceFreshness = formatFreshness(
    state.snapshot.updatedAt,
    freshnessNow,
  );
  const preparedForCurrentMatch =
    listening.preparationState === "ready" &&
    listening.preparedFixtureId === fixtureId &&
    listening.preparedPerspectiveTeam === favoriteTeam;
  const listeningButtonLabel =
    listening.fixtureId === fixtureId && listening.sessionId
      ? "Listening is on"
      : listening.preparationState === "preparing"
        ? "Preparing listening"
        : listening.preparationState === "failed"
          ? "Listening unavailable"
          : "Start listening";
  return (
    <main className="live-canvas" id="main-content">
      <Masthead
        end={`${state.dataMode.toUpperCase()} · ${state.transportHealth.toUpperCase()}`}
      />
      <button className="back-button" type="button" onClick={onBack}>
        <BackIcon /> Today
      </button>
      <section className="live-score-stage" aria-label="Current match score">
        <div className="live-provenance">
          <span>
            {state.snapshot.sourceLabel ?? "SIMULATION · TXLINE-SHAPED DATA"}
          </span>
          <span className="live-source-status">
            <b className={`connection ${state.transportHealth}`}>
              TRANSPORT · {state.transportHealth.toUpperCase()}
            </b>
            <time dateTime={state.snapshot.updatedAt}>{sourceFreshness}</time>
          </span>
        </div>
        <div className="score-grid">
          <div>
            <Flag code={state.snapshot.homeTeam} large />
            <span>
              <small>{state.snapshot.homeTeam}</small>
              <b>{teamName(state.snapshot.homeTeam)}</b>
            </span>
          </div>
          <div className="score-lockup">
            <span>{state.snapshot.score.home}</span>
            <i>—</i>
            <span>{state.snapshot.score.away}</span>
            <small>
              {state.snapshot.minute} · REV {state.currentRevision}
            </small>
          </div>
          <div>
            <span>
              <small>{state.snapshot.awayTeam}</small>
              <b>{teamName(state.snapshot.awayTeam)}</b>
            </span>
            <Flag code={state.snapshot.awayTeam} large />
          </div>
        </div>
        <div className="live-last-event" aria-live="polite">
          <span>Last event</span>
          <b>
            {state.snapshot.lastEvent
              ? `Goal · ${teamName(state.snapshot.lastEvent.eventTeam)} · ${state.snapshot.lastEvent.minute}`
              : "Awaiting kickoff event"}
          </b>
          <small>
            {state.snapshot.lastEvent
              ? state.snapshot.lastEvent.identity
              : "Canonical feed ready"}
          </small>
        </div>
      </section>
      <section className="control-rail">
        <div>
          <p className="kicker">Listening Mode</p>
          <h2>Put the match in your pocket.</h2>
          <p>
            Start once. Later canonical events arrive through the same
            continuous audio channel.
          </p>
        </div>
        <button
          className="primary-control"
          type="button"
          disabled={!preparedForCurrentMatch}
          onClick={() => void listening.start()}
        >
          <SoundIcon />
          {listeningButtonLabel}
        </button>
      </section>
      <section className="match-detail-grid">
        <div className="timeline-panel">
          <div className="section-head">
            <span>Match wire</span>
            <b>{state.timeline.length} events</b>
          </div>
          {state.timeline.length ? (
            state.timeline.map((moment) => {
              const commentary = state.commentaryByMoment[moment.identity];
              return (
                <div className="timeline-row" key={moment.identity}>
                  <span>{moment.minute}</span>
                  <b>Goal · {teamName(moment.eventTeam)}</b>
                  <small>{moment.identity}</small>
                  <p className="timeline-commentary">
                    {commentary?.text ?? "Commentary is warming up…"}
                  </p>
                </div>
              );
            })
          ) : (
            <p className="timeline-empty">
              The wire is calm. Use Demo Lab to send the first real canonical
              event.
            </p>
          )}
        </div>
        {state.dataMode === "simulation" ? (
          <div className="demo-panel">
            <p className="kicker">Demo Lab</p>
            <h2>Prove the whole loop.</h2>
            <p>
              Replay → adapter → reducer → SSE → score → Moment → every active
              listener.
            </p>
            <button
              type="button"
              onClick={() => void playGoal()}
              disabled={isPlayingDemo}
            >
              {isPlayingDemo ? "Advancing replay" : "Play goal"}
              <ArrowIcon />
            </button>
            {error ? (
              <p className="inline-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="demo-panel">
            <p className="kicker">TxLINE source</p>
            <h2>The match wire is automatic.</h2>
            <p>
              Reconciled TxLINE updates now drive the score, Moment, transcript,
              and every active listening stream without a demo button.
            </p>
          </div>
        )}
      </section>
      <Provenance label={state.snapshot.sourceLabel} />
      {state.openMoment ? (
        <GoalMoment
          commentary={state.commentaryByMoment[state.openMoment.identity]}
          homeTeam={state.snapshot.homeTeam}
          awayTeam={state.snapshot.awayTeam}
          moment={state.openMoment}
          relation={relation}
          onClose={() => dispatch({ type: "close_moment" })}
        />
      ) : null}
    </main>
  );
}

function GoalMoment({
  commentary,
  homeTeam,
  awayTeam,
  moment,
  relation,
  onClose,
}: {
  commentary?: LiveCommentary | undefined;
  homeTeam: TeamCode;
  awayTeam: TeamCode;
  moment: LiveMoment;
  relation: "for" | "neutral";
  onClose(): void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 5_600);
    return () => window.clearTimeout(timer);
  }, [onClose]);
  return (
    <section
      className={`goal-moment ${relation}`}
      role="dialog"
      aria-modal="true"
      aria-label="Confirmed goal Moment"
    >
      <div className="moment-truth-rail">
        <span>Goal · confirmed</span>
        <b>
          {homeTeam} {moment.score.home}—{moment.score.away} {awayTeam}
        </b>
        <span>
          {moment.minute} · revision {moment.revision}
        </span>
      </div>
      <div className="goal-pitch" aria-hidden="true">
        <i />
        <i />
        <Flag code={moment.eventTeam} large />
      </div>
      <p className="goal-word">GOAL</p>
      <div className="goal-consequence">
        <p className="kicker">Current canonical moment</p>
        <h2>{teamName(moment.eventTeam)} change the match.</h2>
        <p>The score was already current before this celebration opened.</p>
        <p className="moment-commentary">
          {commentary?.text ?? "Live commentary is being prepared."}
        </p>
        <small>{moment.identity}</small>
      </div>
      <button className="moment-close" type="button" onClick={onClose}>
        Return to match
      </button>
    </section>
  );
}

function Provenance({ label }: { label?: string | undefined }) {
  return (
    <footer className="provenance">
      {label ?? "SIMULATION · TXLINE-SHAPED DATA"}{" "}
      <span>Facts stay fixed · presentation adapts</span>
    </footer>
  );
}

function Flag({ code, large = false }: { code: TeamCode; large?: boolean }) {
  return (
    <span
      className={`flag flag-${code.toLowerCase()} ${large ? "flag-large" : ""}`}
      aria-label={`${code} flag`}
      role="img"
    >
      <i />
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 12H6m5-6-6 6 6 6" />
    </svg>
  );
}

function SoundIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10v4h4l5 4V6L8 10H4Z" />
      <path d="M17 9c2 2 2 4 0 6M20 6c4 4 4 8 0 12" />
    </svg>
  );
}
