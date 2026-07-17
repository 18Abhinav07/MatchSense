import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { ListeningProvider, useListening } from "./ListeningProvider.js";
import {
  ConfirmedGoalMoment,
  FreshnessBanner,
  MatchMemory,
  ReconnectCatchUp,
  type MomentScore,
  type MomentTeam,
} from "./features/moments/index.js";
import {
  RoomExperience,
  type RoomExperienceRoute,
  type RoomFixture,
} from "./features/rooms/index.js";
import { createRoomApi } from "./features/rooms/room-api.js";
import { getOrCreateFanIdentity } from "./fan-identity.js";
import {
  eventLabel,
  fallbackTeam,
  fetchCatalog,
  fetchFixture,
  fetchFixtures,
  fixtureState,
  parseCanonicalEvent,
  parseCatchupEvent,
  parseCommentaryEvent,
  parseSnapshotEvent,
  type ProductCatalog,
  type ProductTeam,
} from "./live-api.js";
import {
  enableMomentPush,
  showLocalMomentNotification,
  triggerTestMomentPush,
} from "./push-notifications.js";
import {
  createInitialLiveState,
  formatFreshness,
  type LiveMoment,
  type LiveSnapshot,
  liveViewReducer,
  normalizePath,
  type TeamCode,
} from "./product-state.js";

const DEMO_FIXTURE_ID = "arg-fra-demo";
const FAVORITE_KEY = "matchsense.favoriteTeam";
const CATALOG_EMPTY: ProductCatalog = { teams: [] };

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface AppProps {
  initialFavoriteTeam?: TeamCode | null;
  initialPath?: string;
}

function safeStoredFavorite(): TeamCode | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(FAVORITE_KEY)?.trim().toUpperCase();
  return value && /^[A-Z0-9_-]{2,12}$/u.test(value) ? value : null;
}

function browserPath() {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

function standalone() {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  );
}

function momentTeam(team: ProductTeam): MomentTeam {
  return {
    code: team.code,
    ...(team.foreground ? { foreground: team.foreground } : {}),
    name: team.name,
    primary: team.primary,
    secondary: team.secondary,
  };
}

function teamFor(
  code: TeamCode,
  catalog: ProductCatalog,
  suppliedName?: string,
) {
  return (
    catalog.teams.find((team) => team.code === code) ??
    fallbackTeam(code, suppliedName)
  );
}

function nameFor(code: TeamCode, catalog: ProductCatalog, supplied?: string) {
  return teamFor(code, catalog, supplied).name;
}

function scoreFor(
  snapshot: LiveSnapshot,
  catalog: ProductCatalog,
): MomentScore {
  return {
    away: snapshot.score.away,
    awayTeam: momentTeam(
      teamFor(snapshot.awayTeam, catalog, snapshot.awayTeamName),
    ),
    home: snapshot.score.home,
    homeTeam: momentTeam(
      teamFor(snapshot.homeTeam, catalog, snapshot.homeTeamName),
    ),
  };
}

function roomFixtureFor(
  snapshot: LiveSnapshot,
  catalog: ProductCatalog,
): RoomFixture {
  return {
    awayTeam: momentTeam(
      teamFor(snapshot.awayTeam, catalog, snapshot.awayTeamName),
    ),
    homeTeam: momentTeam(
      teamFor(snapshot.homeTeam, catalog, snapshot.homeTeamName),
    ),
    id: snapshot.fixtureId,
    isReplay: snapshot.provenance === "synthetic_txline_shaped",
    kickoffAt:
      snapshot.kickoffAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function useCatalog() {
  const [catalog, setCatalog] = useState(CATALOG_EMPTY);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    fetchCatalog(controller.signal)
      .then((next) => {
        setCatalog(next);
        setStatus(next.teams.length ? "ready" : "error");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError")
          setStatus("error");
      });
    return () => controller.abort();
  }, [reload]);
  return { catalog, retry: () => setReload((value) => value + 1), status };
}

export function App(props: AppProps = {}) {
  return (
    <ListeningProvider>
      <ProductApp {...props} />
    </ListeningProvider>
  );
}

function ProductApp({ initialFavoriteTeam, initialPath }: AppProps) {
  const initialRoute = normalizePath(initialPath ?? browserPath());
  const [path, setPath] = useState(initialRoute);
  const isDemo = path === "/demo" || path.startsWith("/demo/");
  const [fanId] = useState(() =>
    typeof window === "undefined"
      ? "server-preview"
      : getOrCreateFanIdentity(window.localStorage),
  );
  const [favoriteTeam, setFavoriteTeam] = useState<TeamCode | null>(() =>
    initialFavoriteTeam === undefined
      ? (safeStoredFavorite() ??
        (initialRoute.startsWith("/demo") ? "ARG" : null))
      : initialFavoriteTeam,
  );
  const [onboardingStage, setOnboardingStage] = useState<
    "pick" | "moment" | "buzz" | "done"
  >(() => (favoriteTeam ? "done" : "pick"));
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const catalogState = useCatalog();

  useEffect(() => {
    const onPop = () => setPath(normalizePath(window.location.pathname));
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeinstallprompt", onInstall);
    };
  }, []);

  const navigate = useCallback((next: string) => {
    window.history.pushState({}, "", next);
    setPath(normalizePath(next));
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  const pickTeam = (team: TeamCode) => {
    setFavoriteTeam(team);
    window.localStorage.setItem(FAVORITE_KEY, team);
    setOnboardingStage("moment");
  };

  useEffect(() => {
    if (onboardingStage !== "moment") return;
    const timeout = window.setTimeout(() => setOnboardingStage("buzz"), 4_600);
    return () => window.clearTimeout(timeout);
  }, [onboardingStage]);

  if (!isDemo && (!favoriteTeam || onboardingStage === "pick")) {
    return (
      <TeamPick
        catalog={catalogState.catalog}
        onPick={pickTeam}
        onRetry={catalogState.retry}
        status={catalogState.status}
      />
    );
  }
  const supported = favoriteTeam ?? "ARG";
  if (!isDemo && onboardingStage === "moment") {
    return (
      <SampleMoment
        team={teamFor(supported, catalogState.catalog)}
        onContinue={() => setOnboardingStage("buzz")}
      />
    );
  }
  if (!isDemo && onboardingStage === "buzz") {
    return (
      <BuzzSetup
        installPrompt={installPrompt}
        team={teamFor(supported, catalogState.catalog)}
        onComplete={() => setOnboardingStage("done")}
      />
    );
  }

  if (isDemo) {
    return (
      <LiveCompanion
        catalog={catalogState.catalog}
        demoMode
        favoriteTeam={supported}
        fixtureId={DEMO_FIXTURE_ID}
        onBack={() => navigate("/")}
        onOpenMemory={() => navigate(`/matches/${DEMO_FIXTURE_ID}/memory`)}
      />
    );
  }

  const momentRoute = path.match(/^\/matches\/([^/]+)\/moments\/([^/]+)$/u);
  if (momentRoute?.[1] && momentRoute[2]) {
    return (
      <LiveCompanion
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        fixtureId={decodeURIComponent(momentRoute[1])}
        initialMomentIdentity={decodeURIComponent(momentRoute[2])}
        onBack={() => navigate("/")}
        onMomentClose={() =>
          navigate(`/matches/${decodeURIComponent(momentRoute[1]!)}/live`)
        }
      />
    );
  }
  if (path === "/rooms" || path === "/rooms/new") {
    return (
      <RoomsSurface
        catalog={catalogState.catalog}
        fanId={fanId}
        favoriteTeam={supported}
        navigate={navigate}
        route={{ mode: "create" }}
      />
    );
  }
  const roomInvite = path.match(/^\/rooms\/join\/([^/]+)$/u);
  if (roomInvite?.[1]) {
    return (
      <RoomsSurface
        catalog={catalogState.catalog}
        fanId={fanId}
        favoriteTeam={supported}
        navigate={navigate}
        route={{ inviteCode: roomInvite[1], mode: "invite" }}
      />
    );
  }
  const roomRoute = path.match(/^\/rooms\/([^/]+)$/u);
  if (roomRoute?.[1]) {
    return (
      <RoomsSurface
        catalog={catalogState.catalog}
        fanId={fanId}
        favoriteTeam={supported}
        navigate={navigate}
        route={{ mode: "room", roomId: roomRoute[1] }}
      />
    );
  }
  if (path === "/history") {
    return (
      <HistorySurface
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        onBack={() => navigate("/")}
        onOpen={(fixtureId) => navigate(`/matches/${fixtureId}/memory`)}
      />
    );
  }
  const memoryRoute = path.match(/^\/matches\/([^/]+)\/memory$/u);
  if (memoryRoute?.[1]) {
    return (
      <MatchMemoryScreen
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        fixtureId={decodeURIComponent(memoryRoute[1])}
        onBack={() => navigate(`/matches/${memoryRoute[1]}/live`)}
        onReplay={() => navigate(`/matches/${memoryRoute[1]}/live`)}
      />
    );
  }
  const liveRoute = path.match(/^\/matches\/([^/]+)(?:\/live)?$/u);
  if (liveRoute?.[1]) {
    const fixtureId = decodeURIComponent(liveRoute[1]);
    return (
      <LiveCompanion
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        fixtureId={fixtureId}
        onBack={() => navigate("/")}
        onOpenMemory={() => navigate(`/matches/${fixtureId}/memory`)}
      />
    );
  }
  return (
    <Today
      catalog={catalogState.catalog}
      favoriteTeam={supported}
      installPrompt={installPrompt}
      onChangeTeam={() => {
        setOnboardingStage("pick");
        setFavoriteTeam(null);
        window.localStorage.removeItem(FAVORITE_KEY);
      }}
      onCreateRoom={() => navigate("/rooms/new")}
      onDemo={() => navigate("/demo")}
      onHistory={() => navigate("/history")}
      onOpen={(fixtureId) => navigate(`/matches/${fixtureId}/live`)}
    />
  );
}

function Masthead({ end, demo = false }: { end: string; demo?: boolean }) {
  return (
    <header className="masthead">
      <a className="wordmark" href="/" aria-label="MatchSense home">
        Match<span>Sense</span>
      </a>
      {demo ? <strong className="demo-mode-badge">DEMO MODE</strong> : null}
      <span className="mast-status">
        <i />
        {end}
      </span>
    </header>
  );
}

function TeamPick({
  catalog,
  onPick,
  onRetry,
  status,
}: {
  catalog: ProductCatalog;
  onPick(team: TeamCode): void;
  onRetry(): void;
  status: "loading" | "ready" | "error";
}) {
  const [query, setQuery] = useState("");
  const filtered = catalog.teams.filter(({ code, name }) =>
    `${code} ${name}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <main className="onboarding-shell" id="main-content">
      <Masthead end="Your tournament · 1 of 2" />
      <section className="team-pick-grid">
        <div className="onboarding-copy">
          <p className="kicker">Make the match yours</p>
          <h1>Who do you support?</h1>
          <p>
            MatchSense changes atmosphere and emphasis around your team. Match
            truth never changes.
          </p>
          <label className="team-search">
            <span>Search every team in the live catalog</span>
            <input
              aria-label="Search teams"
              autoComplete="off"
              disabled={status !== "ready"}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Type a country or code"
              value={query}
            />
          </label>
        </div>
        <div className="team-field" role="list" aria-label="Tournament teams">
          {status === "loading" ? (
            <TeamLoading />
          ) : status === "error" ? (
            <DataError
              action="Try the live catalog again"
              detail="We could not load tournament teams. MatchSense will not invent a list."
              onRetry={onRetry}
              title="The team sheet is late."
            />
          ) : (
            filtered.map((team, index) => (
              <button
                className="team-choice"
                key={team.code}
                onClick={() => onPick(team.code)}
                style={{ "--order": index } as CSSProperties}
                type="button"
              >
                <TeamMark large team={team} />
                <span>
                  <small>{team.code}</small>
                  <b>{team.name}</b>
                  <em>Personalize Moments, audio, alerts, and rooms</em>
                </span>
                <ArrowIcon />
              </button>
            ))
          )}
          {status === "ready" && filtered.length === 0 ? (
            <p className="empty-state">No team matches that search.</p>
          ) : null}
        </div>
      </section>
      <Provenance label={catalog.sourceLabel ?? "TXLINE TOURNAMENT CATALOG"} />
    </main>
  );
}

function TeamLoading() {
  return (
    <div className="team-loading" aria-live="polite">
      {[0, 1, 2, 3].map((item) => (
        <i key={item} />
      ))}
      <span>Loading the tournament team sheet…</span>
    </div>
  );
}

export function SampleMoment({
  team,
  onContinue,
}: {
  team: ProductTeam | TeamCode;
  onContinue(): void;
}) {
  const sampleNames: Record<string, string> = {
    ARG: "Argentina",
    BRA: "Brazil",
    ESP: "Spain",
    FRA: "France",
    JPN: "Japan",
  };
  const supported =
    typeof team === "string"
      ? fallbackTeam(team, sampleNames[team] ?? team)
      : team;
  const opponent =
    supported.code === "FRA"
      ? fallbackTeam("ARG", "Argentina")
      : fallbackTeam("FRA", "France");
  return (
    <main
      className="sample-moment"
      id="main-content"
      style={{ "--team": supported.primary } as CSSProperties}
    >
      <div className="moment-truth-rail">
        <span>Replay sample · confirmed</span>
        <b>
          {supported.code} 1—0 {opponent.code}
        </b>
        <span>23′ · sample revision 1</span>
      </div>
      <div className="moment-stage" aria-live="polite">
        <div className="textile-plane" aria-hidden="true">
          <TeamMark large team={supported} />
        </div>
        <p className="moment-word">GOAL</p>
        <div className="moment-copy">
          <p className="kicker">Feel it now</p>
          <h1>
            {supported.name} take the lead against {opponent.name}.
          </h1>
          <p>
            The score arrives first. Then sound, motion, and your team&apos;s
            atmosphere turn a data update into a Moment.
          </p>
        </div>
      </div>
      <div className="moment-footer">
        <span>ONBOARDING REPLAY · CLEARLY LABELLED</span>
        <button className="quiet-button" type="button" onClick={onContinue}>
          Keep this feeling <ArrowIcon />
        </button>
      </div>
    </main>
  );
}

function BuzzSetup({
  installPrompt,
  team,
  onComplete,
}: {
  installPrompt: BeforeInstallPromptEvent | null;
  team: ProductTeam;
  onComplete(): void;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const ios = /iPad|iPhone|iPod/u.test(navigator.userAgent);
  const enable = async () => {
    if (ios && !standalone()) {
      setState("error");
      return;
    }
    setState("working");
    try {
      if (installPrompt && !standalone()) {
        await installPrompt.prompt();
        if ((await installPrompt.userChoice).outcome === "dismissed") {
          setState("idle");
          return;
        }
      }
      const fixture = (await fetchFixtures())[0];
      if (!fixture) throw new Error("No fixture available");
      const sample = {
        body: `${team.name} lead 1–0. Tap for the full Moment.`,
        fixtureId: fixture.fixtureId,
        momentId: `${fixture.fixtureId}:welcome`,
        occurredAt: new Date().toISOString(),
        revision: 1,
        title: `⚽ GOAL — ${team.name} lead 1–0`,
      };
      const response = await fetch("/api/v1/push/config");
      if (!response.ok) throw new Error("Push unavailable");
      const config = (await response.json()) as {
        applicationServerKey?: unknown;
      };
      if (typeof config.applicationServerKey !== "string")
        throw new Error("Push invalid");
      const registration = await enableMomentPush({
        applicationServerKey: config.applicationServerKey,
      });
      try {
        await triggerTestMomentPush(registration.id, sample);
      } catch {
        await showLocalMomentNotification(sample);
      }
      setState("done");
      window.setTimeout(onComplete, 800);
    } catch {
      setState("error");
    }
  };
  return (
    <main className="buzz-shell" id="main-content">
      <Masthead end="Alerts · 2 of 2" />
      <section className="buzz-layout">
        <div className="buzz-copy">
          <p className="kicker">Take the match with you</p>
          <h1>Want a buzz when {team.name} change the game?</h1>
          <p>
            Your lock screen gets a factual system alert. Tap it for the full
            team-colored animation and commentary inside MatchSense.
          </p>
          {ios && !standalone() ? (
            <div className="ios-install-note">
              <span>Required on iPhone</span>
              <b>Share ↑ · Add to Home Screen · open MatchSense again</b>
              <small>Web push becomes available after installation.</small>
            </div>
          ) : null}
          <div className="buzz-actions">
            <button
              className="primary-control"
              disabled={state === "working"}
              onClick={() => void enable()}
              type="button"
            >
              <SoundIcon />
              {state === "working"
                ? "Opening your alert channel"
                : state === "done"
                  ? "Your alerts are ready"
                  : "Install and enable alerts"}
            </button>
            <button className="quiet-button" onClick={onComplete} type="button">
              Continue without alerts
            </button>
          </div>
          {state === "error" ? (
            <p className="inline-error" role="status">
              Alerts are not available yet on this device. Install first on
              iPhone, or enable notifications in browser settings. Everything
              else remains usable.
            </p>
          ) : null}
        </div>
        <LockscreenPreview team={team} />
      </section>
    </main>
  );
}

function LockscreenPreview({ team }: { team: ProductTeam }) {
  return (
    <div
      className="lockscreen-preview"
      aria-label="Honest sample of an operating system lock-screen alert"
      style={{ "--team": team.primary } as CSSProperties}
    >
      <div className="lockscreen-time">
        <span>Matchday</span>
        <b>20:23</b>
      </div>
      <div className="sample-notification">
        <div className="notification-app-icon">MS</div>
        <div>
          <span>MATCHSENSE · NOW</span>
          <b>⚽ GOAL — {team.name} lead 1–0</b>
          <p>Tap to feel the Moment and hear the live call.</p>
        </div>
      </div>
      <small>Preview only · your operating system controls the real card</small>
    </div>
  );
}

function Today({
  catalog,
  favoriteTeam,
  installPrompt,
  onChangeTeam,
  onCreateRoom,
  onDemo,
  onHistory,
  onOpen,
}: {
  catalog: ProductCatalog;
  favoriteTeam: TeamCode;
  installPrompt: BeforeInstallPromptEvent | null;
  onChangeTeam(): void;
  onCreateRoom(): void;
  onDemo(): void;
  onHistory(): void;
  onOpen(fixtureId: string): void;
}) {
  const [fixtures, setFixtures] = useState<LiveSnapshot[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [reload, setReload] = useState(0);
  const [alertOpen, setAlertOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    fetchFixtures(controller.signal)
      .then((items) => {
        setFixtures(items);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError")
          setStatus("error");
      });
    return () => controller.abort();
  }, [reload]);

  const prioritized = [...fixtures].sort((a, b) => {
    const aFavorite =
      a.homeTeam === favoriteTeam || a.awayTeam === favoriteTeam;
    const bFavorite =
      b.homeTeam === favoriteTeam || b.awayTeam === favoriteTeam;
    if (aFavorite !== bFavorite) return aFavorite ? -1 : 1;
    const rank = { live: 0, upcoming: 1, final: 2 } as const;
    const stateDiff = rank[fixtureState(a)] - rank[fixtureState(b)];
    if (stateDiff) return stateDiff;
    return Date.parse(a.kickoffAt ?? "") - Date.parse(b.kickoffAt ?? "");
  });
  const favorite = teamFor(favoriteTeam, catalog);
  return (
    <main className="app-canvas" id="main-content">
      <Masthead end="LIVE PRODUCT · TXLINE" />
      <AppNav
        active="today"
        onDemo={onDemo}
        onHistory={onHistory}
        onRooms={onCreateRoom}
        onToday={() => undefined}
      />
      <section className="today-hero">
        <div>
          <p className="kicker">Your World Cup, always within reach</p>
          <h1>Stay in the match while life keeps moving.</h1>
          <div className="today-hero-actions">
            <button
              className="primary-control"
              onClick={() => setAlertOpen(true)}
              type="button"
            >
              Turn on match alerts
            </button>
            <button
              className="quiet-button"
              onClick={onChangeTeam}
              type="button"
            >
              Change team
            </button>
          </div>
        </div>
        <div
          className="today-ticket-stamp"
          style={{ "--team": favorite.primary } as CSSProperties}
        >
          <span>Following</span>
          <b>{favorite.code}</b>
          <small>{favorite.name} · adaptive match atmosphere</small>
        </div>
      </section>

      <section className="schedule-section" aria-labelledby="match-schedule">
        <div className="schedule-heading">
          <div>
            <p className="kicker">The tournament wire</p>
            <h2 id="match-schedule">Matches</h2>
          </div>
          <span>{fixtures.length} from the live schedule</span>
        </div>
        {status === "loading" ? (
          <FixtureLoading />
        ) : status === "error" ? (
          <DataError
            action="Reconnect to the schedule"
            detail="Your saved team is safe. We just cannot reach the match schedule yet."
            onRetry={() => setReload((value) => value + 1)}
            title="The match wire is offline."
          />
        ) : prioritized.length === 0 ? (
          <EmptySchedule onDemo={onDemo} />
        ) : (
          <div className="fixture-list">
            {prioritized.map((fixture) => (
              <FixtureCard
                catalog={catalog}
                favoriteTeam={favoriteTeam}
                fixture={fixture}
                key={fixture.fixtureId}
                onOpen={() => onOpen(fixture.fixtureId)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="experience-grid">
        <article className="experience-card listening-card">
          <p className="kicker">Listening Mode</p>
          <h2>A live match call that waits in your pocket.</h2>
          <p>
            Start once from a fixture. Every canonical Moment is called through
            the same continuous audio stream—even with your screen locked.
          </p>
          <span>One tap · continuous channel · media controls</span>
        </article>
        <article className="experience-card social-card">
          <p className="kicker">Rooms · with friends</p>
          <h2>Make five calls, then let the match settle the chat.</h2>
          <p>
            Invite friends before kickoff, allocate your free Sense, and react
            to the same verified Moments together.
          </p>
          <button onClick={onCreateRoom} type="button">
            Create a room <ArrowIcon />
          </button>
        </article>
        <article className="experience-card memory-card">
          <p className="kicker">Match Memory</p>
          <h2>Keep the matches that meant something.</h2>
          <p>
            Finished fixtures become emotional, shareable recaps with key
            Moments and a replay entry point.
          </p>
          <button onClick={onHistory} type="button">
            Open your history <ArrowIcon />
          </button>
        </article>
      </section>
      <section className="demo-entry-card">
        <span>Judging and testing</span>
        <div>
          <h2>Need a match right now?</h2>
          <p>
            Demo Mode is a separate, clearly labelled five-minute match. It
            never leaks simulated cards into the live schedule.
          </p>
        </div>
        <button onClick={onDemo} type="button">
          Open Demo Mode <ArrowIcon />
        </button>
      </section>
      <Provenance label={catalog.sourceLabel ?? "TXLINE TOURNAMENT DATA"} />
      {alertOpen ? (
        <AlertSheet
          installPrompt={installPrompt}
          onClose={() => setAlertOpen(false)}
          team={favorite}
        />
      ) : null}
    </main>
  );
}

function FixtureCard({
  catalog,
  favoriteTeam,
  fixture,
  onOpen,
}: {
  catalog: ProductCatalog;
  favoriteTeam: TeamCode;
  fixture: LiveSnapshot;
  onOpen(): void;
}) {
  const state = fixtureState(fixture);
  const home = teamFor(fixture.homeTeam, catalog, fixture.homeTeamName);
  const away = teamFor(fixture.awayTeam, catalog, fixture.awayTeamName);
  const favored = home.code === favoriteTeam || away.code === favoriteTeam;
  const kickoff = fixture.kickoffAt
    ? new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
      }).format(new Date(fixture.kickoffAt))
    : "Kickoff pending";
  return (
    <article
      className="fixture-card"
      data-favorite={favored}
      data-state={state}
    >
      <div className="fixture-card-meta">
        <span className={`fixture-state fixture-state-${state}`}>
          {state === "live"
            ? "● LIVE"
            : state === "final"
              ? "FULL TIME"
              : kickoff}
        </span>
        <small>{fixture.competition ?? "World Cup"}</small>
      </div>
      <div className="fixture-card-teams">
        <TeamLine
          score={state === "upcoming" ? null : fixture.score.home}
          team={home}
        />
        <TeamLine
          score={state === "upcoming" ? null : fixture.score.away}
          team={away}
        />
      </div>
      <div className="fixture-card-footer">
        <span>
          {state === "live"
            ? `${fixture.minute} · ${fixture.sourceLabel}`
            : (fixture.venue ?? fixture.sourceLabel)}
        </span>
        <button onClick={onOpen} type="button">
          {state === "live" ? "Join live" : "Open companion"}
          <ArrowIcon />
        </button>
      </div>
    </article>
  );
}

function TeamLine({
  score,
  team,
}: {
  score: number | null;
  team: ProductTeam;
}) {
  return (
    <div>
      <TeamMark team={team} />
      <span>
        <small>{team.code}</small>
        <b>{team.name}</b>
      </span>
      {score === null ? <em>—</em> : <strong>{score}</strong>}
    </div>
  );
}

function FixtureLoading() {
  return (
    <div className="fixture-loading" aria-live="polite">
      {[0, 1, 2].map((item) => (
        <i key={item} />
      ))}
      <span>Opening the live schedule…</span>
    </div>
  );
}

function EmptySchedule({ onDemo }: { onDemo(): void }) {
  return (
    <div className="empty-schedule">
      <p className="kicker">No fixtures returned</p>
      <h3>The tournament is quiet right now.</h3>
      <p>
        We will show scheduled, live, and completed matches as soon as TxLINE
        publishes them.
      </p>
      <button className="primary-control" onClick={onDemo} type="button">
        Experience Demo Mode
      </button>
    </div>
  );
}

function DataError({
  action,
  detail,
  onRetry,
  title,
}: {
  action: string;
  detail: string;
  onRetry(): void;
  title: string;
}) {
  return (
    <div className="data-error" role="status">
      <span>!</span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
      <button onClick={onRetry} type="button">
        {action}
      </button>
    </div>
  );
}

function AlertSheet({
  installPrompt,
  onClose,
  team,
}: {
  installPrompt: BeforeInstallPromptEvent | null;
  onClose(): void;
  team: ProductTeam;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const enable = async () => {
    setState("working");
    try {
      if (installPrompt && !standalone()) {
        await installPrompt.prompt();
        if ((await installPrompt.userChoice).outcome === "dismissed") {
          setState("idle");
          return;
        }
      }
      const configResponse = await fetch("/api/v1/push/config");
      if (!configResponse.ok) throw new Error("Push unavailable");
      const config = (await configResponse.json()) as {
        applicationServerKey?: unknown;
      };
      if (typeof config.applicationServerKey !== "string")
        throw new Error("Push invalid");
      await enableMomentPush({
        applicationServerKey: config.applicationServerKey,
      });
      setState("done");
    } catch {
      setState("error");
    }
  };
  return (
    <div className="sheet-scrim" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Match alert setup"
        aria-modal="true"
        className="alert-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <button className="sheet-close" onClick={onClose} type="button">
          Close
        </button>
        <p className="kicker">Match alerts</p>
        <h2>Truth on the lock screen. Atmosphere after the tap.</h2>
        <p>
          Your device controls the notification card. MatchSense sends the
          score, minute, and event; full animation and sound open inside the
          PWA.
        </p>
        <LockscreenPreview team={team} />
        <button
          className="primary-control"
          disabled={state === "working"}
          onClick={() => void enable()}
          type="button"
        >
          {state === "working"
            ? "Opening permission"
            : state === "done"
              ? "Alerts enabled"
              : "Install and enable alerts"}
        </button>
        {state === "error" ? (
          <p className="inline-error">
            Install the PWA first on iPhone, or allow notifications in your
            browser settings.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function LiveCompanion({
  catalog,
  demoMode = false,
  favoriteTeam,
  fixtureId,
  initialMomentIdentity,
  onBack,
  onMomentClose,
  onOpenMemory,
}: {
  catalog: ProductCatalog;
  demoMode?: boolean;
  favoriteTeam: TeamCode;
  fixtureId: string;
  initialMomentIdentity?: string;
  onBack(): void;
  onMomentClose?: () => void;
  onOpenMemory?: () => void;
}) {
  const [state, dispatch] = useReducer(
    liveViewReducer,
    undefined,
    createInitialLiveState,
  );
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [playingDemo, setPlayingDemo] = useState(false);
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
    const offline = () =>
      dispatch({ transportHealth: "offline", type: "transport" });
    const online = () =>
      dispatch({ transportHealth: "connecting", type: "transport" });
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (!navigator.onLine) offline();
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoadState("loading");
    fetchFixture(fixtureId, controller.signal)
      .then((snapshot) => {
        if (!active) return;
        dispatch({ snapshot, type: "snapshot" });
        setLoadState("ready");
        if (initialMomentIdentity && snapshot.lastEvent) {
          const moment = snapshot.lastEvent;
          dispatch({
            payload: {
              event: "moment.created",
              id: moment.identity,
              moment,
              snapshot,
            },
            type: "canonical_event",
          });
          window.setTimeout(
            () => dispatch({ identity: moment.identity, type: "open_moment" }),
            80,
          );
        }
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== "AbortError" && active)
          setLoadState("error");
      });

    const stream = new EventSource(
      `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/stream`,
    );
    const snapshot = (event: MessageEvent<string>) => {
      try {
        const next = parseSnapshotEvent(event.data);
        if (next) dispatch({ snapshot: next, type: "snapshot" });
      } catch {
        /* malformed frames do not replace current truth */
      }
    };
    const moment = (event: MessageEvent<string>) => {
      try {
        const payload = parseCanonicalEvent(event.data);
        if (!payload) return;
        dispatch({ payload, type: "canonical_event" });
        persistMatch(payload.snapshot, payload.moment);
        window.setTimeout(
          () =>
            dispatch({
              identity: payload.moment.identity,
              type: "open_moment",
            }),
          70,
        );
      } catch {
        /* preserve last reconciled snapshot */
      }
    };
    const commentary = (event: MessageEvent<string>) => {
      try {
        const payload = parseCommentaryEvent(event.data);
        if (payload) dispatch({ payload, type: "commentary_ready" });
      } catch {
        /* transcript is optional */
      }
    };
    const catchup = (event: MessageEvent<string>) => {
      try {
        const payload = parseCatchupEvent(event.data);
        if (payload) dispatch({ payload, type: "catchup_ready" });
      } catch {
        /* browser EventSource will continue */
      }
    };
    stream.addEventListener("snapshot", snapshot as EventListener);
    stream.addEventListener("moment.created", moment as EventListener);
    stream.addEventListener("moment.revised", moment as EventListener);
    stream.addEventListener("commentary.ready", commentary as EventListener);
    stream.addEventListener("catchup.ready", catchup as EventListener);
    stream.onopen = () =>
      dispatch({ transportHealth: "reconciled", type: "transport" });
    stream.onerror = () =>
      dispatch({ transportHealth: "stale", type: "transport" });
    return () => {
      active = false;
      controller.abort();
      stream.close();
    };
  }, [fixtureId, initialMomentIdentity]);

  const playNextDemoBeat = async () => {
    setPlayingDemo(true);
    setError(null);
    try {
      if (!replaySession.current) {
        const response = await fetch("/api/v1/replay/sessions", {
          body: JSON.stringify({ fixtureId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!response.ok) throw new Error("Demo unavailable");
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
      if (!response.ok) throw new Error("Demo command failed");
    } catch {
      setError("The demo could not advance. Try once more.");
    } finally {
      setPlayingDemo(false);
    }
  };

  const snapshot =
    state.snapshot.fixtureId === fixtureId ? state.snapshot : null;
  if (loadState === "loading" && !snapshot) {
    return <MatchLoading demo={demoMode} onBack={onBack} />;
  }
  if (loadState === "error" && !snapshot) {
    return (
      <main className="live-canvas">
        <Masthead demo={demoMode} end="MATCH UNAVAILABLE" />
        <button className="back-button" onClick={onBack} type="button">
          <BackIcon /> Today
        </button>
        <DataError
          action="Return to the schedule"
          detail="This fixture is not available from the server right now."
          onRetry={onBack}
          title="We could not open this match."
        />
      </main>
    );
  }
  const current = snapshot ?? state.snapshot;
  const home = teamFor(current.homeTeam, catalog, current.homeTeamName);
  const away = teamFor(current.awayTeam, catalog, current.awayTeamName);
  const freshness = formatFreshness(current.updatedAt, freshnessNow);
  const prepared =
    listening.preparationState === "ready" &&
    listening.preparedFixtureId === fixtureId &&
    listening.preparedPerspectiveTeam === favoriteTeam;
  const activeListening =
    listening.fixtureId === fixtureId && Boolean(listening.sessionId);
  const startListening = () => {
    if (activeListening) {
      if (listening.state === "paused" || listening.state === "blocked")
        void listening.resume();
      else listening.pause();
    } else void listening.start();
  };
  const listeningLabel =
    !prepared && !activeListening
      ? listening.preparationState === "failed"
        ? "Listening unavailable"
        : "Preparing audio…"
      : activeListening
        ? listening.state === "paused"
          ? "Resume listening"
          : "Pause listening"
        : "Start listening";
  return (
    <main className="live-canvas" id="main-content">
      <Masthead
        demo={demoMode}
        end={`${demoMode ? "REPLAY" : "TXLINE"} · ${state.transportHealth.toUpperCase()}`}
      />
      <button className="back-button" onClick={onBack} type="button">
        <BackIcon /> {demoMode ? "Exit demo" : "Today"}
      </button>
      {demoMode ? (
        <div className="demo-disclosure">
          <b>DEMO MODE</b>
          <span>
            Scripted Argentina–France replay · separate from live fixtures
          </span>
        </div>
      ) : null}
      {state.transportHealth === "stale" ||
      state.transportHealth === "offline" ? (
        <FreshnessBanner
          age={freshness.replace("UPDATED ", "").toLowerCase()}
          asOf={current.minute}
          status={state.transportHealth}
        />
      ) : null}
      <section className="live-score-stage" aria-label="Current match score">
        <div className="live-provenance">
          <span>{current.sourceLabel ?? "TXLINE MATCH DATA"}</span>
          <span className="live-source-status">
            <b className={`connection ${state.transportHealth}`}>
              {state.transportHealth === "reconciled"
                ? "● CONNECTED"
                : state.transportHealth.toUpperCase()}
            </b>
            <time dateTime={current.updatedAt}>{freshness}</time>
          </span>
        </div>
        <div className="score-grid">
          <div>
            <TeamMark large team={home} />
            <span>
              <small>{home.code}</small>
              <b>{home.name}</b>
            </span>
          </div>
          <div className="score-lockup">
            <span>{current.score.home}</span>
            <i>—</i>
            <span>{current.score.away}</span>
            <small>
              {current.minute} · {current.phase?.replaceAll("_", " ")}
            </small>
          </div>
          <div>
            <span>
              <small>{away.code}</small>
              <b>{away.name}</b>
            </span>
            <TeamMark large team={away} />
          </div>
        </div>
        <div className="live-last-event" aria-live="polite">
          <span>Latest</span>
          <b>
            {current.lastEvent
              ? `${eventLabel(current.lastEvent)} · ${nameFor(current.lastEvent.eventTeam, catalog)}`
              : fixtureState(current) === "upcoming"
                ? "Waiting for kickoff"
                : "The match wire is calm"}
          </b>
          <small>
            {current.lastEvent?.minute ??
              (current.kickoffAt
                ? kickoffLabel(current.kickoffAt)
                : "Feed ready")}
          </small>
        </div>
      </section>
      <section className="control-rail">
        <div>
          <p className="kicker">Listening Mode</p>
          <h2>Put the match in your pocket.</h2>
          <p>
            A continuous commentary channel stays mounted while you move around
            the PWA or lock your screen.
          </p>
        </div>
        <button
          className="primary-control"
          disabled={!prepared && !activeListening}
          onClick={startListening}
          type="button"
        >
          <SoundIcon /> {listeningLabel}
        </button>
      </section>
      <section className="match-detail-grid">
        <div className="timeline-panel">
          <div className="section-head">
            <span>Match wire</span>
            <b>{state.timeline.length} Moments</b>
          </div>
          {state.timeline.length ? (
            state.timeline.map((moment) => (
              <TimelineRow
                catalog={catalog}
                commentary={state.commentaryByMoment[moment.identity]?.text}
                key={moment.identity}
                moment={moment}
              />
            ))
          ) : (
            <p className="timeline-empty">
              {fixtureState(current) === "upcoming"
                ? "The companion is ready. Live Moments will appear here at kickoff."
                : "Connected. Waiting for the next canonical event."}
            </p>
          )}
        </div>
        <aside className="match-side-panel">
          <div className="match-fact">
            <span>Status</span>
            <b>
              {fixtureState(current) === "live"
                ? "Live now"
                : fixtureState(current) === "final"
                  ? "Final"
                  : kickoffLabel(current.kickoffAt)}
            </b>
            <small>{current.competition ?? "World Cup"}</small>
          </div>
          <div className="match-fact">
            <span>Your view</span>
            <b>{nameFor(favoriteTeam, catalog)}</b>
            <small>Moments and commentary adapt; facts do not.</small>
          </div>
          {onOpenMemory ? (
            <button
              className="side-action"
              onClick={() => {
                persistMatch(current);
                onOpenMemory();
              }}
              type="button"
            >
              Open Match Memory <ArrowIcon />
            </button>
          ) : null}
          {demoMode ? (
            <div className="demo-controls">
              <span>Demo conductor</span>
              <h3>Run the next match beat.</h3>
              <p>
                Every click enters through the same match stream used by the UI
                and active listeners.
              </p>
              <button
                disabled={playingDemo}
                onClick={() => void playNextDemoBeat()}
                type="button"
              >
                {playingDemo ? "Advancing…" : "Play next event"}
                <ArrowIcon />
              </button>
              {error ? <p className="inline-error">{error}</p> : null}
            </div>
          ) : null}
        </aside>
      </section>
      <Provenance label={current.sourceLabel} />
      {state.openMoment ? (
        <MomentOverlay
          catalog={catalog}
          commentary={state.commentaryByMoment[state.openMoment.identity]?.text}
          favoriteTeam={favoriteTeam}
          moment={state.openMoment}
          onClose={() => {
            dispatch({ type: "close_moment" });
            onMomentClose?.();
          }}
          snapshot={current}
        />
      ) : null}
      {state.catchup ? (
        <ReconnectCatchUp
          caughtUpAt="just now"
          events={state.catchup.moments.map((moment, index) => ({
            id: moment.id,
            kind: catchupKind(moment.kind),
            minute: moment.minute,
            revision: moment.revision,
            sequence: index + 1,
            team: momentTeam(teamFor(moment.eventTeam, catalog)),
            title: eventLabel(moment),
          }))}
          onContinue={() => dispatch({ type: "acknowledge_catchup" })}
          sourceLabel={current.sourceLabel ?? "TXLINE MATCH DATA"}
        />
      ) : null}
    </main>
  );
}

function catchupKind(
  kind: string,
):
  | "goal"
  | "yellow_card"
  | "red_card"
  | "var"
  | "half_time"
  | "full_time"
  | "other" {
  return (
    ["goal", "yellow_card", "red_card", "half_time", "full_time"] as string[]
  ).includes(kind)
    ? (kind as "goal" | "yellow_card" | "red_card" | "half_time" | "full_time")
    : kind.startsWith("var")
      ? "var"
      : "other";
}

function TimelineRow({
  catalog,
  commentary,
  moment,
}: {
  catalog: ProductCatalog;
  commentary?: string | undefined;
  moment: LiveMoment;
}) {
  const team = teamFor(moment.eventTeam, catalog);
  return (
    <article className="timeline-row" data-kind={moment.kind}>
      <span>{moment.minute}</span>
      <div>
        <b>{eventLabel(moment)}</b>
        <small>{moment.playerName ?? team.name}</small>
      </div>
      <em>
        {moment.score.home}—{moment.score.away}
      </em>
      {commentary || moment.detail ? (
        <p className="timeline-commentary">{commentary ?? moment.detail}</p>
      ) : null}
    </article>
  );
}

function MomentOverlay({
  catalog,
  commentary,
  favoriteTeam,
  moment,
  onClose,
  snapshot,
}: {
  catalog: ProductCatalog;
  commentary?: string | undefined;
  favoriteTeam: TeamCode;
  moment: LiveMoment;
  onClose(): void;
  snapshot: LiveSnapshot;
}) {
  const team = teamFor(moment.eventTeam, catalog);
  if (moment.kind === "goal") {
    return (
      <ConfirmedGoalMoment
        commentary={
          commentary ??
          "The commentary call is following this confirmed Moment."
        }
        consequence={
          moment.eventTeam === favoriteTeam
            ? `${team.name} just changed your match.`
            : `${team.name} changed the score. The match truth is already current.`
        }
        onClose={onClose}
        {...(moment.playerName ? { playerName: moment.playerName } : {})}
        relation={moment.eventTeam === favoriteTeam ? "for" : "against"}
        score={scoreFor(snapshot, catalog)}
        scoringTeam={momentTeam(team)}
        truth={{
          eventId: moment.identity,
          minute: moment.minute,
          revision: moment.revision,
          ...(snapshot.sourceLabel
            ? { sourceLabel: snapshot.sourceLabel }
            : {}),
        }}
      />
    );
  }
  const tone =
    moment.kind === "red_card" || moment.kind.includes("overturned")
      ? "danger"
      : moment.kind === "yellow_card"
        ? "warning"
        : "neutral";
  return (
    <section
      className="event-moment"
      data-tone={tone}
      role="dialog"
      aria-modal="true"
      aria-label={`${eventLabel(moment)} Moment`}
      style={{ "--team": team.primary } as CSSProperties}
    >
      <header>
        <span>
          {eventLabel(moment)} · {moment.status}
        </span>
        <b>
          {snapshot.homeTeam} {snapshot.score.home}—{snapshot.score.away}{" "}
          {snapshot.awayTeam}
        </b>
        <span>
          {moment.minute} · revision {moment.revision}
        </span>
      </header>
      <div className="event-moment-field">
        <TeamMark large team={team} />
        <p>
          {moment.kind.includes("card")
            ? "CARD"
            : moment.kind.startsWith("var")
              ? "VAR"
              : "MATCH"}
        </p>
      </div>
      <div className="event-moment-copy">
        <p className="kicker">Canonical Moment</p>
        <h2>{eventLabel(moment)}.</h2>
        <p>
          {moment.playerName
            ? `${moment.playerName} · ${team.name}`
            : (moment.detail ??
              `${team.name} are at the center of this update.`)}
        </p>
        {commentary ? <blockquote>{commentary}</blockquote> : null}
      </div>
      <button onClick={onClose} type="button">
        Return to match
      </button>
    </section>
  );
}

function MatchLoading({ demo, onBack }: { demo: boolean; onBack(): void }) {
  return (
    <main className="live-canvas">
      <Masthead demo={demo} end="CONNECTING TO MATCH" />
      <button className="back-button" onClick={onBack} type="button">
        <BackIcon /> Back
      </button>
      <div className="match-loading">
        <span />
        <span />
        <p>Reconciling the latest score before we show the match…</p>
      </div>
    </main>
  );
}

function MatchMemoryScreen({
  catalog,
  favoriteTeam,
  fixtureId,
  onBack,
  onReplay,
}: {
  catalog: ProductCatalog;
  favoriteTeam: TeamCode;
  fixtureId: string;
  onBack(): void;
  onReplay(): void;
}) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(
    () => readStoredMatch(fixtureId)?.snapshot ?? null,
  );
  const [moments, setMoments] = useState<LiveMoment[]>(
    () => readStoredMatch(fixtureId)?.moments ?? [],
  );
  const [error, setError] = useState(false);
  const [shared, setShared] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchFixture(fixtureId, controller.signal)
      .then((next) => setSnapshot(next))
      .catch(() => setError(true));
    return () => controller.abort();
  }, [fixtureId]);
  if (!snapshot) {
    return (
      <main className="memory-shell">
        <Masthead end="MATCH MEMORY" />
        {error ? (
          <DataError
            action="Back to the match"
            detail="No saved or live match record is available."
            onRetry={onBack}
            title="This memory is not ready."
          />
        ) : (
          <p className="memory-loading">Gathering how the match felt…</p>
        )}
      </main>
    );
  }
  const home = teamFor(snapshot.homeTeam, catalog, snapshot.homeTeamName);
  const away = teamFor(snapshot.awayTeam, catalog, snapshot.awayTeamName);
  const supported = favoriteTeam === away.code ? away : home;
  const final = fixtureState(snapshot) === "final";
  if (!final) {
    return (
      <main className="memory-shell">
        <Masthead end={snapshot.sourceLabel ?? "MATCH MEMORY"} />
        <section className="memory-locked">
          <p className="kicker">Match Memory</p>
          <h1>This memory is still being written.</h1>
          <p>
            It unlocks after the source finalises the match. Key Moments are
            being saved as the game unfolds.
          </p>
          <button className="primary-control" onClick={onBack} type="button">
            Return to the match
          </button>
        </section>
      </main>
    );
  }
  const share = async () => {
    const text = `${home.name} ${snapshot.score.home}–${snapshot.score.away} ${away.name} · my MatchSense Memory`;
    try {
      if (navigator.share)
        await navigator.share({
          text,
          title: "My MatchSense Memory",
          url: window.location.href,
        });
      else
        await navigator.clipboard.writeText(`${text} ${window.location.href}`);
      setShared(true);
    } catch {
      setShared(false);
    }
  };
  return (
    <main className="memory-shell">
      <MatchMemory
        moments={moments.map((moment) => ({
          ...(moment.detail ? { detail: moment.detail } : {}),
          id: moment.identity,
          kind: catchupKind(moment.kind),
          minute: moment.minute,
          team: momentTeam(teamFor(moment.eventTeam, catalog)),
          title: eventLabel(moment),
        }))}
        onReplay={onReplay}
        onShare={() => void share()}
        score={scoreFor(snapshot, catalog)}
        stats={[
          {
            away: snapshot.score.away,
            home: snapshot.score.home,
            label: "Goals",
          },
          { away: "—", home: "—", label: "Cards" },
          { away: "—", home: "—", label: "Corners" },
        ]}
        summary={`${supported.name}'s night: ${moments.length || "every"} key Moment${moments.length === 1 ? "" : "s"}, one final score, kept exactly as it unfolded.`}
        supportedTeam={momentTeam(supported)}
        truth={{
          eventId: snapshot.lastEvent?.identity ?? `${fixtureId}:final`,
          minute: "FT",
          revision: snapshot.revision ?? 0,
          ...(snapshot.sourceLabel
            ? { sourceLabel: snapshot.sourceLabel }
            : {}),
        }}
      />
      {shared ? (
        <p className="share-confirmation">Memory ready to share.</p>
      ) : null}
    </main>
  );
}

interface StoredMatch {
  snapshot: LiveSnapshot;
  moments: LiveMoment[];
  savedAt: string;
}

function readStoredMatches(): StoredMatch[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem("matchsense.matchHistory") ?? "[]",
    ) as unknown;
    return Array.isArray(value) ? (value as StoredMatch[]) : [];
  } catch {
    return [];
  }
}

function readStoredMatch(fixtureId: string) {
  return readStoredMatches().find(
    (entry) => entry.snapshot.fixtureId === fixtureId,
  );
}

function persistMatch(snapshot: LiveSnapshot, moment?: LiveMoment) {
  const stored = readStoredMatches();
  const existing = stored.find(
    (entry) => entry.snapshot.fixtureId === snapshot.fixtureId,
  );
  const moments = existing?.moments ?? [];
  const nextMoments = moment
    ? [moment, ...moments.filter((item) => item.id !== moment.id)]
    : moments;
  const next: StoredMatch = {
    moments: nextMoments.slice(0, 80),
    savedAt: new Date().toISOString(),
    snapshot,
  };
  const rest = stored.filter(
    (entry) => entry.snapshot.fixtureId !== snapshot.fixtureId,
  );
  try {
    window.localStorage.setItem(
      "matchsense.matchHistory",
      JSON.stringify([next, ...rest].slice(0, 24)),
    );
  } catch {
    /* storage is best effort */
  }
}

function HistorySurface({
  catalog,
  favoriteTeam,
  onBack,
  onOpen,
}: {
  catalog: ProductCatalog;
  favoriteTeam: TeamCode;
  onBack(): void;
  onOpen(fixtureId: string): void;
}) {
  const [entries, setEntries] = useState<StoredMatch[]>(readStoredMatches);
  useEffect(() => {
    fetchFixtures()
      .then((fixtures) => {
        const completed = fixtures.filter(
          (fixture) => fixtureState(fixture) === "final",
        );
        setEntries((current) => {
          const ids = new Set(current.map((entry) => entry.snapshot.fixtureId));
          return [
            ...current,
            ...completed
              .filter((fixture) => !ids.has(fixture.fixtureId))
              .map((snapshot) => ({
                moments: [],
                savedAt: snapshot.updatedAt ?? new Date().toISOString(),
                snapshot,
              })),
          ];
        });
      })
      .catch(() => undefined);
  }, []);
  return (
    <main className="history-shell" id="main-content">
      <Masthead end="YOUR MATCH MEMORY" />
      <button className="back-button" onClick={onBack} type="button">
        <BackIcon /> Today
      </button>
      <section className="history-hero">
        <p className="kicker">Memory</p>
        <h1>The matches that stayed with you.</h1>
        <p>
          Key Moments are saved on this device as you follow. Final results
          remain source-linked.
        </p>
      </section>
      {entries.length ? (
        <div className="history-grid">
          {entries.map((entry) => {
            const snapshot = entry.snapshot;
            const home = teamFor(
              snapshot.homeTeam,
              catalog,
              snapshot.homeTeamName,
            );
            const away = teamFor(
              snapshot.awayTeam,
              catalog,
              snapshot.awayTeamName,
            );
            return (
              <button
                className="history-card"
                key={snapshot.fixtureId}
                onClick={() => onOpen(snapshot.fixtureId)}
                type="button"
              >
                <span>
                  {home.code} {snapshot.score.home}—{snapshot.score.away}{" "}
                  {away.code}
                </span>
                <h2>
                  {home.name} v {away.name}
                </h2>
                <p>
                  {entry.moments.length} saved Moment
                  {entry.moments.length === 1 ? "" : "s"} ·{" "}
                  {favoriteTeam === home.code || favoriteTeam === away.code
                    ? "your team"
                    : "followed match"}
                </p>
                <small>
                  Open memory and replay <ArrowIcon />
                </small>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-memory">
          <span>00</span>
          <h2>Your first Match Memory starts here.</h2>
          <p>
            Follow a live fixture and MatchSense will keep its important turns
            on this device.
          </p>
          <button className="primary-control" onClick={onBack} type="button">
            Choose a match
          </button>
        </div>
      )}
    </main>
  );
}

function RoomsSurface({
  catalog,
  fanId,
  favoriteTeam,
  navigate,
  route,
}: {
  catalog: ProductCatalog;
  fanId: string;
  favoriteTeam: TeamCode;
  navigate(path: string): void;
  route:
    | { mode: "create" }
    | { inviteCode: string; mode: "invite" }
    | { mode: "room"; roomId: string };
}) {
  const [fixture, setFixture] = useState<LiveSnapshot | null>(null);
  const [fixtureStateValue, setFixtureStateValue] = useState<
    "loading" | "ready" | "empty"
  >("loading");
  useEffect(() => {
    if (route.mode !== "create") return;
    fetchFixtures()
      .then((fixtures) => {
        const upcoming =
          fixtures.find((item) => fixtureState(item) === "upcoming") ??
          fixtures[0] ??
          null;
        setFixture(upcoming);
        setFixtureStateValue(upcoming ? "ready" : "empty");
      })
      .catch(() => setFixtureStateValue("empty"));
  }, [route.mode]);
  const roomApi = useMemo(
    () =>
      createRoomApi({
        fanId,
        favoriteTeam,
        origin:
          typeof window === "undefined"
            ? "http://matchsense.local"
            : window.location.origin,
      }),
    [fanId, favoriteTeam],
  );
  if (route.mode === "create" && fixtureStateValue === "loading")
    return (
      <main className="rooms-shell">
        <Masthead end="OPENING ROOMS" />
        <p className="memory-loading">Finding the next match for your room…</p>
      </main>
    );
  if (route.mode === "create" && !fixture)
    return (
      <main className="rooms-shell">
        <Masthead end="ROOMS" />
        <DataError
          action="Back to Today"
          detail="A room needs an upcoming fixture. None is available right now."
          onRetry={() => navigate("/")}
          title="No match to call yet."
        />
      </main>
    );
  const storedNickname =
    typeof window === "undefined"
      ? ""
      : (window.localStorage.getItem("matchsense.nickname") ?? "");
  const experienceRoute: RoomExperienceRoute =
    route.mode === "create"
      ? {
          defaultNickname: storedNickname,
          defaultRoomName: "Match Night",
          fixture: roomFixtureFor(fixture!, catalog),
          mode: "create",
        }
      : route.mode === "invite"
        ? {
            defaultNickname: storedNickname,
            inviteCode: route.inviteCode,
            mode: "invite",
            teamCode: favoriteTeam,
          }
        : { mode: "room", roomId: route.roomId };
  return (
    <main className="rooms-shell" id="main-content">
      <RoomExperience
        api={roomApi}
        onExit={() => navigate("/")}
        onOpenMatch={(id) => navigate(`/matches/${id}/live`)}
        onOpenRoom={(id) => navigate(`/rooms/${id}`)}
        route={experienceRoute}
      />
    </main>
  );
}

function AppNav({
  active,
  onDemo,
  onHistory,
  onRooms,
  onToday,
}: {
  active: "today" | "history" | "rooms";
  onDemo(): void;
  onHistory(): void;
  onRooms(): void;
  onToday(): void;
}) {
  return (
    <nav className="app-nav" aria-label="Primary">
      <button data-active={active === "today"} onClick={onToday} type="button">
        Today
      </button>
      <button
        data-active={active === "history"}
        onClick={onHistory}
        type="button"
      >
        Memory
      </button>
      <button data-active={active === "rooms"} onClick={onRooms} type="button">
        Rooms
      </button>
      <button className="nav-demo" onClick={onDemo} type="button">
        Demo
      </button>
    </nav>
  );
}

function TeamMark({
  large = false,
  team,
}: {
  large?: boolean;
  team: ProductTeam;
}) {
  return (
    <span
      className={`team-mark${large ? " team-mark-large" : ""}`}
      role="img"
      aria-label={`${team.name} team mark`}
      style={
        {
          "--team": team.primary,
          "--team-secondary": team.secondary,
          "--team-ink": team.foreground ?? "#f7f4ea",
        } as CSSProperties
      }
    >
      {team.flagUrl ? (
        <img alt="" src={team.flagUrl} />
      ) : (
        <i aria-hidden="true" />
      )}
      <b>{team.code.slice(0, 3)}</b>
    </span>
  );
}

function kickoffLabel(value?: string) {
  if (!value) return "Kickoff pending";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Kickoff pending";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

function Provenance({ label }: { label?: string | undefined }) {
  return (
    <footer className="provenance">
      {label ?? "MATCHSENSE LIVE PRODUCT"}
      <span>Facts stay fixed · presentation adapts</span>
    </footer>
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
