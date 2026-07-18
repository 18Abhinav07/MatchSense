import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { ListeningProvider, useListening } from "./ListeningProvider.js";
import {
  MemorySourceNotice,
  type MemoryDataSource,
} from "./MemorySourceNotice.js";
import { TeamFlag } from "./components/TeamFlag.js";
import {
  createFanProfileApi,
  type FanBootstrap,
  type FanProfile,
  needsProfileCompletion,
  profileComplete,
} from "./fan-profile.js";
import {
  AvatarStep,
  type FanCardDraft,
  FirstLaunchIntro,
  HandleStep,
  ProfileCompletionOverlay,
  ProfileSurface,
} from "./features/fan/FanSurfaces.js";
import {
  ConfirmedGoalMoment,
  FreshnessBanner,
  MatchMemory,
  memoryReplayPath,
  MemoryReplayPlayer,
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
import {
  createDemoViewState,
  demoEventPresentation,
  demoViewReducer,
  parseDemoBeatEvent,
  type DemoBeatEvent,
  type DemoBeatType,
} from "./features/demo/demo-state.js";
import {
  eventLabel,
  fallbackTeam,
  fetchCatalog,
  fetchFixture,
  fetchFixtures,
  fetchMomentResolution,
  fixtureState,
  parseCanonicalEvent,
  parseCatchupEvent,
  parseCommentaryEvent,
  parseSnapshotEvent,
  type ProductCatalog,
  type ProductTeam,
} from "./live-api.js";
import { fetchMatchMemories, fetchMatchMemory } from "./memory-api.js";
import { loadMemoryHistory, loadOneMemory } from "./memory-loader.js";
import { matchMemoryView, type MatchMemoryView } from "./memory-view.js";
import { enableMomentPush } from "./push-notifications.js";
import { parseMomentActivation } from "./notification-activation.js";
import {
  createInitialLiveState,
  formatFreshness,
  type LiveMoment,
  type LiveSnapshot,
  liveViewReducer,
  normalizePath,
  type TeamCode,
} from "./product-state.js";

const INTRO_SEEN_KEY = "matchsense.introSeen";
const CATALOG_EMPTY: ProductCatalog = { teams: [] };

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface AppProps {
  initialFavoriteTeam?: TeamCode | null;
  initialPath?: string;
}

function browserPath() {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

function publicProductPath(path: string) {
  return path === "/demo" || path.startsWith("/demo/") ? "/" : path;
}

export function roomCreationPath(fixtureId: string) {
  return `/rooms/new/${encodeURIComponent(fixtureId)}`;
}

export async function resolveRoomCreationFixture(
  fixtureId: string | null,
  dependencies: {
    fetchExact(fixtureId: string): Promise<LiveSnapshot>;
    fetchSchedule(): Promise<LiveSnapshot[]>;
  } = {
    fetchExact: fetchFixture,
    fetchSchedule: fetchFixtures,
  },
) {
  if (fixtureId) return dependencies.fetchExact(fixtureId);
  const fixtures = await dependencies.fetchSchedule();
  return (
    fixtures.find((item) => fixtureState(item) === "upcoming") ??
    fixtures[0] ??
    null
  );
}

export function shouldOfferRoomCreation(snapshot: LiveSnapshot) {
  return (
    fixtureState(snapshot) === "upcoming" &&
    snapshot.provenance !== "synthetic_txline_shaped" &&
    !snapshot.fixtureId.startsWith("experience:")
  );
}

function previewFan(team: TeamCode | null): FanProfile | null {
  if (!team) return null;
  const now = "2026-07-17T00:00:00.000Z";
  return {
    avatarVariant: `${team.toLowerCase()}-pulse`,
    createdAt: now,
    deletedAt: null,
    favoriteTeam: team,
    handle: `supporter_${team.toLowerCase()}`,
    handleNormalized: `supporter_${team.toLowerCase()}`,
    id: "server-preview",
    preferences: {},
    profile: {},
    updatedAt: now,
  };
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
    ...(team.flagUrl ? { flagUrl: team.flagUrl } : {}),
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
  const initialRoute = publicProductPath(
    normalizePath(initialPath ?? browserPath()),
  );
  const [path, setPath] = useState(initialRoute);
  const fanApi = useMemo(() => createFanProfileApi(), []);
  const [bootstrap, setBootstrap] = useState<FanBootstrap | null>(() => {
    const fan = previewFan(initialFavoriteTeam ?? null);
    return fan ? { fan, follows: [], memories: [], rooms: [] } : null;
  });
  const [bootstrapStatus, setBootstrapStatus] = useState<
    "loading" | "ready" | "error"
  >(() => (initialFavoriteTeam === undefined ? "loading" : "ready"));
  const [draftTeam, setDraftTeam] = useState<TeamCode | null>(
    initialFavoriteTeam ?? null,
  );
  const [draftHandle, setDraftHandle] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [experienceState, setExperienceState] = useState<
    "idle" | "starting" | "error"
  >("idle");
  const [onboardingStage, setOnboardingStage] = useState<
    | "booting"
    | "intro"
    | "pick"
    | "handle"
    | "avatar"
    | "moment"
    | "buzz"
    | "minimal"
    | "done"
  >(() => {
    if (initialFavoriteTeam) return "done";
    if (initialFavoriteTeam === null) {
      return needsProfileCompletion(null, initialRoute) ? "minimal" : "intro";
    }
    return "booting";
  });
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const catalogState = useCatalog();
  const fan = bootstrap?.fan ?? null;
  const favoriteTeam = fan?.favoriteTeam ?? draftTeam;
  const fanId = fan?.id ?? "server-preview";

  const loadBootstrap = useCallback(async () => {
    setBootstrapStatus("loading");
    try {
      const next = await fanApi.ensureBootstrap();
      setBootstrap(next);
      setDraftTeam(next.fan.favoriteTeam);
      setDraftHandle(next.fan.handle ?? "");
      setBootstrapStatus("ready");
      if (profileComplete(next.fan)) {
        setOnboardingStage("done");
      } else if (needsProfileCompletion(next.fan, initialRoute)) {
        setOnboardingStage("minimal");
      } else {
        const introSeen = window.localStorage.getItem(INTRO_SEEN_KEY) === "1";
        setOnboardingStage(introSeen ? "pick" : "intro");
      }
    } catch {
      setBootstrapStatus("error");
    }
  }, [fanApi, initialRoute]);

  useEffect(() => {
    if (initialFavoriteTeam !== undefined) return;
    void loadBootstrap();
  }, [initialFavoriteTeam, loadBootstrap]);

  useEffect(() => {
    const onPop = () =>
      setPath(publicProductPath(normalizePath(window.location.pathname)));
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

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const onServiceWorkerMessage = (event: MessageEvent<unknown>) => {
      const activation = parseMomentActivation(
        event.data,
        window.location.origin,
      );
      if (!activation) return;
      window.history.pushState({}, "", activation.url);
      setPath(normalizePath(activation.url));
      if (needsProfileCompletion(fan, activation.url)) {
        setOnboardingStage("minimal");
      }
    };
    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    return () =>
      navigator.serviceWorker.removeEventListener(
        "message",
        onServiceWorkerMessage,
      );
  }, [fan]);

  const navigate = useCallback((next: string) => {
    window.history.pushState({}, "", next);
    setPath(normalizePath(next));
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  const persistFollow = useCallback(
    async (
      fixtureId: string,
      mode: "demo" | "live",
      eventPreferences: Record<string, boolean> = {
        fullTime: true,
        goals: true,
        redCards: true,
      },
    ) => {
      await fanApi.followFixture(fixtureId, mode, eventPreferences);
      setBootstrap((current) => {
        if (!current) return current;
        return {
          ...current,
          follows: [
            ...current.follows.filter(
              (follow) =>
                follow.fixtureId !== fixtureId || follow.mode !== mode,
            ),
            { eventPreferences, fixtureId, mode },
          ],
        };
      });
    },
    [fanApi],
  );

  const pickTeam = (team: TeamCode) => {
    setDraftTeam(team);
    setProfileError(null);
    setOnboardingStage("handle");
  };

  const checkHandle = async (handle: string) => {
    setProfileBusy(true);
    setProfileError(null);
    try {
      const result = await fanApi.checkHandle(handle);
      if (!result.available) {
        setProfileError("That handle is already supporting someone else.");
        return;
      }
      setDraftHandle(result.handle);
      setOnboardingStage("avatar");
    } catch {
      setProfileError("We could not reserve that handle. Try another one.");
    } finally {
      setProfileBusy(false);
    }
  };

  const saveFanCard = async (draft: FanCardDraft) => {
    setProfileBusy(true);
    setProfileError(null);
    try {
      const updated = await fanApi.updateProfile({
        avatarVariant: draft.avatarVariant,
        favoriteTeam: draft.favoriteTeam,
        handle: draft.handle,
        preferences: {
          alertsFullTime: true,
          alertsGoals: true,
          alertsRedCards: true,
          captions: true,
          commentaryLanguage: "en",
          commentaryVoice: "stadium",
          ...(fan?.preferences ?? {}),
        },
        profile: fan?.profile ?? {},
      });
      setBootstrap((current) => ({
        fan: updated,
        follows: current?.follows ?? [],
        memories: current?.memories ?? [],
        rooms: current?.rooms ?? [],
      }));
      setDraftTeam(updated.favoriteTeam);
      setDraftHandle(updated.handle ?? draft.handle);
      return true;
    } catch {
      setProfileError(
        "That fan card could not be saved. Check the handle and try again.",
      );
      return false;
    } finally {
      setProfileBusy(false);
    }
  };

  const chooseAvatar = async (avatarVariant: string) => {
    if (!draftTeam || !draftHandle) return;
    const saved = await saveFanCard({
      avatarVariant,
      favoriteTeam: draftTeam,
      handle: draftHandle,
    });
    if (saved) setOnboardingStage("moment");
  };

  const completeMinimalProfile = async (draft: FanCardDraft) => {
    const saved = await saveFanCard(draft);
    if (saved) setOnboardingStage("done");
  };

  const finishIntro = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(INTRO_SEEN_KEY, "1");
    }
    setOnboardingStage("pick");
  }, []);

  useEffect(() => {
    if (onboardingStage !== "moment") return;
    const timeout = window.setTimeout(() => setOnboardingStage("buzz"), 4_600);
    return () => window.clearTimeout(timeout);
  }, [onboardingStage]);

  if (onboardingStage === "booting" || bootstrapStatus === "loading") {
    return (
      <main className="onboarding-shell" id="main-content">
        <Masthead end="OPENING YOUR MATCH DAY" />
        <div className="match-loading">
          <span />
          <span />
          <p>Preparing your private supporter card…</p>
        </div>
      </main>
    );
  }
  if (bootstrapStatus === "error") {
    return (
      <main className="onboarding-shell" id="main-content">
        <Masthead end="PROFILE CONNECTION" />
        <DataError
          action="Try again"
          detail="Your matches are safe. MatchSense just could not open your supporter profile."
          onRetry={() => void loadBootstrap()}
          title="The fan entrance is offline."
        />
      </main>
    );
  }
  if (onboardingStage === "intro") {
    return <FirstLaunchIntro onComplete={finishIntro} />;
  }
  if (onboardingStage === "pick") {
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
  const startExperience = async () => {
    if (experienceState === "starting") return;
    setExperienceState("starting");
    const opponent =
      catalogState.catalog.teams.find((team) => team.code !== supported)
        ?.code ?? (supported === "FRA" ? "ARG" : "FRA");
    try {
      const run = await fanApi.startExperience({
        awayTeam: opponent,
        homeTeam: supported,
        idempotencyKey: `experience:${globalThis.crypto.randomUUID()}`,
      });
      await persistFollow(run.fixtureId, "demo", {
        fullTime: true,
        goals: true,
        halfTime: true,
        penalties: true,
        redCards: true,
        var: true,
        yellowCards: true,
      });
      setExperienceState("idle");
      navigate(`/matches/${encodeURIComponent(run.fixtureId)}/live`);
    } catch {
      setExperienceState("error");
    }
  };
  if (onboardingStage === "handle") {
    return (
      <HandleStep
        busy={profileBusy}
        error={profileError}
        onContinue={(handle) => void checkHandle(handle)}
        team={teamFor(supported, catalogState.catalog)}
      />
    );
  }
  if (onboardingStage === "avatar") {
    return (
      <AvatarStep
        busy={profileBusy}
        error={profileError}
        handle={draftHandle}
        onChoose={(variant) => void chooseAvatar(variant)}
        team={teamFor(supported, catalogState.catalog)}
      />
    );
  }
  if (onboardingStage === "moment") {
    return (
      <SampleMoment
        team={teamFor(supported, catalogState.catalog)}
        onContinue={() => setOnboardingStage("buzz")}
      />
    );
  }
  if (onboardingStage === "buzz") {
    return (
      <BuzzSetup
        installPrompt={installPrompt}
        onFollow={persistFollow}
        team={teamFor(supported, catalogState.catalog)}
        onComplete={() => setOnboardingStage("done")}
      />
    );
  }

  const withProfileCompletion = (surface: ReactNode) => (
    <>
      {surface}
      {onboardingStage === "minimal" ? (
        <ProfileCompletionOverlay
          busy={profileBusy}
          catalog={catalogState.catalog}
          error={profileError}
          onComplete={(draft) => void completeMinimalProfile(draft)}
        />
      ) : null}
    </>
  );

  if (path === "/experience/with-friends") {
    return withProfileCompletion(
      <ExperienceFriendsSurface
        catalog={catalogState.catalog}
        fanId={fanId}
        favoriteTeam={supported}
        navigate={navigate}
      />,
    );
  }

  const momentRoute = path.match(/^\/matches\/([^/]+)\/moments\/([^/]+)$/u);
  if (momentRoute?.[1] && momentRoute[2]) {
    const fixtureId = decodeURIComponent(momentRoute[1]);
    return withProfileCompletion(
      <LiveCompanion
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        fixtureId={fixtureId}
        initialMomentIdentity={decodeURIComponent(momentRoute[2])}
        onBack={() => navigate("/")}
        onCreateRoom={() => navigate(roomCreationPath(fixtureId))}
        onMomentClose={() =>
          navigate(`/matches/${encodeURIComponent(fixtureId)}/live`)
        }
      />,
    );
  }
  if (path === "/you") {
    const profileFan = fan ?? previewFan(supported)!;
    return withProfileCompletion(
      <ProfileSurface
        api={fanApi}
        catalog={catalogState.catalog}
        fan={profileFan}
        onBack={() => navigate("/")}
        onDeleted={() => {
          setBootstrap(null);
          setDraftTeam(null);
          setDraftHandle("");
          setOnboardingStage("intro");
          navigate("/");
        }}
        onSaved={(updated) =>
          setBootstrap((current) => ({
            fan: updated,
            follows: current?.follows ?? [],
            memories: current?.memories ?? [],
            rooms: current?.rooms ?? [],
          }))
        }
      />,
    );
  }
  if (path === "/rooms" || path === "/rooms/new") {
    return withProfileCompletion(
      <RoomsSurface
        catalog={catalogState.catalog}
        fanId={fanId}
        favoriteTeam={supported}
        navigate={navigate}
        route={{ mode: "create" }}
      />,
    );
  }
  const roomCreate = path.match(/^\/rooms\/new\/([^/]+)$/u);
  if (roomCreate?.[1]) {
    return withProfileCompletion(
      <RoomsSurface
        catalog={catalogState.catalog}
        fanId={fanId}
        favoriteTeam={supported}
        navigate={navigate}
        route={{
          fixtureId: decodeURIComponent(roomCreate[1]),
          mode: "create",
        }}
      />,
    );
  }
  const roomInvite = path.match(/^\/rooms\/join\/([^/]+)$/u);
  if (roomInvite?.[1]) {
    return withProfileCompletion(
      <RoomsSurface
        catalog={catalogState.catalog}
        fanId={fanId}
        favoriteTeam={supported}
        navigate={navigate}
        route={{ inviteCode: roomInvite[1], mode: "invite" }}
      />,
    );
  }
  const roomRoute = path.match(/^\/rooms\/([^/]+)$/u);
  if (roomRoute?.[1]) {
    return withProfileCompletion(
      <RoomsSurface
        catalog={catalogState.catalog}
        fanId={fanId}
        favoriteTeam={supported}
        navigate={navigate}
        route={{ mode: "room", roomId: roomRoute[1] }}
      />,
    );
  }
  if (path === "/history") {
    return withProfileCompletion(
      <HistorySurface
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        onBack={() => navigate("/")}
        onOpen={(fixtureId) => navigate(memoryReplayPath(fixtureId))}
      />,
    );
  }
  const memoryReplayRoute = path.match(/^\/matches\/([^/]+)\/memory\/replay$/u);
  if (memoryReplayRoute?.[1]) {
    const fixtureId = decodeURIComponent(memoryReplayRoute[1]);
    return withProfileCompletion(
      <MatchMemoryReplayScreen
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        fixtureId={fixtureId}
        onBack={() => navigate("/history")}
        onOpenMemory={() =>
          navigate(`/matches/${encodeURIComponent(fixtureId)}/memory`)
        }
      />,
    );
  }
  const memoryRoute = path.match(/^\/matches\/([^/]+)\/memory$/u);
  if (memoryRoute?.[1]) {
    const fixtureId = decodeURIComponent(memoryRoute[1]);
    return withProfileCompletion(
      <MatchMemoryScreen
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        fixtureId={fixtureId}
        onBack={() =>
          navigate(`/matches/${encodeURIComponent(fixtureId)}/live`)
        }
        onReplay={() => navigate(memoryReplayPath(fixtureId))}
      />,
    );
  }
  const liveRoute = path.match(/^\/matches\/([^/]+)(?:\/live)?$/u);
  if (liveRoute?.[1]) {
    const fixtureId = decodeURIComponent(liveRoute[1]);
    return withProfileCompletion(
      <LiveCompanion
        catalog={catalogState.catalog}
        favoriteTeam={supported}
        fixtureId={fixtureId}
        onBack={() => navigate("/")}
        onCreateRoom={() => navigate(roomCreationPath(fixtureId))}
        onOpenMemory={() => navigate(`/matches/${fixtureId}/memory`)}
      />,
    );
  }
  return (
    <Today
      catalog={catalogState.catalog}
      favoriteTeam={supported}
      follows={bootstrap?.follows ?? []}
      installPrompt={installPrompt}
      onChangeTeam={() => navigate("/you")}
      onCreateRoom={() => navigate("/rooms/new")}
      onExperience={() => void startExperience()}
      onExperienceWithFriends={() => navigate("/experience/with-friends")}
      experienceState={experienceState}
      onHistory={() => navigate("/history")}
      onOpen={(fixtureId) => navigate(`/matches/${fixtureId}/live`)}
      onFollow={persistFollow}
      onProfile={() => navigate("/you")}
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
  onFollow,
  team,
  onComplete,
}: {
  installPrompt: BeforeInstallPromptEvent | null;
  onFollow(
    fixtureId: string,
    mode: "demo" | "live",
    preferences?: Record<string, boolean>,
  ): Promise<void>;
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
      const available = await fetchFixtures();
      const fixture =
        available.find(
          (candidate) =>
            (candidate.homeTeam === team.code ||
              candidate.awayTeam === team.code) &&
            fixtureState(candidate) !== "final",
        ) ?? available[0];
      if (!fixture) throw new Error("No fixture available");
      const response = await fetch("/api/v1/push/config");
      if (!response.ok) throw new Error("Push unavailable");
      const config = (await response.json()) as {
        applicationServerKey?: unknown;
      };
      if (typeof config.applicationServerKey !== "string")
        throw new Error("Push invalid");
      await enableMomentPush({
        applicationServerKey: config.applicationServerKey,
      });
      await onFollow(
        fixture.fixtureId,
        fixture.provenance === "synthetic_txline_shaped" ? "demo" : "live",
      );
      const serviceWorker = await navigator.serviceWorker.ready;
      await serviceWorker.showNotification("MatchSense alerts are ready", {
        body: `You will get factual ${team.name} match updates here.`,
        data: { url: "/" },
        icon: "/icons/matchsense-icon.svg",
        tag: "matchsense:alerts-ready",
      });
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
  experienceState,
  favoriteTeam,
  follows,
  installPrompt,
  onChangeTeam,
  onCreateRoom,
  onExperience,
  onExperienceWithFriends,
  onHistory,
  onOpen,
  onFollow,
  onProfile,
}: {
  catalog: ProductCatalog;
  experienceState: "idle" | "starting" | "error";
  favoriteTeam: TeamCode;
  follows: FanBootstrap["follows"];
  installPrompt: BeforeInstallPromptEvent | null;
  onChangeTeam(): void;
  onCreateRoom(): void;
  onExperience(): void;
  onExperienceWithFriends(): void;
  onHistory(): void;
  onOpen(fixtureId: string): void;
  onFollow(
    fixtureId: string,
    mode: "demo" | "live",
    preferences?: Record<string, boolean>,
  ): Promise<void>;
  onProfile(): void;
}) {
  const [fixtures, setFixtures] = useState<LiveSnapshot[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [reload, setReload] = useState(0);
  const [alertTarget, setAlertTarget] = useState<LiveSnapshot | null | false>(
    false,
  );
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
  const followedFixtureIds = new Set(follows.map(({ fixtureId }) => fixtureId));
  const alertFixtures = alertTarget
    ? [alertTarget]
    : fixtures.filter(
        (fixture) =>
          (fixture.homeTeam === favoriteTeam ||
            fixture.awayTeam === favoriteTeam) &&
          fixtureState(fixture) !== "final",
      );
  const persistAlertFollows = async () => {
    await Promise.all(
      alertFixtures.map((fixture) =>
        onFollow(
          fixture.fixtureId,
          fixture.provenance === "synthetic_txline_shaped" ? "demo" : "live",
        ),
      ),
    );
  };
  return (
    <main className="app-canvas" id="main-content">
      <Masthead end="LIVE PRODUCT · TXLINE" />
      <AppNav
        active="today"
        onRooms={onCreateRoom}
        onToday={() => undefined}
        onYou={onProfile}
      />
      <section className="today-hero">
        <div>
          <p className="kicker">Your World Cup, always within reach</p>
          <h1>Stay in the match while life keeps moving.</h1>
          <div className="today-hero-actions">
            <button
              className="primary-control"
              onClick={() => setAlertTarget(null)}
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
          <b>
            <TeamFlag size="compact" team={favorite} /> {favorite.code}
          </b>
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
          <EmptySchedule />
        ) : (
          <div className="fixture-list">
            {prioritized.map((fixture) => (
              <FixtureCard
                catalog={catalog}
                favoriteTeam={favoriteTeam}
                fixture={fixture}
                followed={followedFixtureIds.has(fixture.fixtureId)}
                key={fixture.fixtureId}
                onAlert={() => setAlertTarget(fixture)}
                onOpen={() => onOpen(fixture.fixtureId)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="experience-grid">
        <article className="experience-card experience-match-card">
          <p className="kicker">Experience Match · always available</p>
          <h2>Put your team into a complete five-minute live match.</h2>
          <p>
            Real companion, lock-screen goal alerts, canonical VAR, continuous
            commentary and Memory—all on the same server-owned event engine as a
            live fixture.
          </p>
          <div className="experience-launch-actions">
            <button
              disabled={experienceState === "starting"}
              onClick={onExperience}
              type="button"
            >
              {experienceState === "starting"
                ? "Preparing your match…"
                : "Start solo"}{" "}
              <ArrowIcon />
            </button>
            <button onClick={onExperienceWithFriends} type="button">
              Start with friends <ArrowIcon />
            </button>
          </div>
          {experienceState === "error" ? (
            <small role="status">
              The Experience match could not start. Tap again to retry.
            </small>
          ) : null}
        </article>
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
      <Provenance label={catalog.sourceLabel ?? "TXLINE TOURNAMENT DATA"} />
      {alertTarget !== false ? (
        <AlertSheet
          fixtureCount={alertFixtures.length}
          installPrompt={installPrompt}
          onClose={() => setAlertTarget(false)}
          onEnabled={persistAlertFollows}
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
  followed,
  onAlert,
  onOpen,
}: {
  catalog: ProductCatalog;
  favoriteTeam: TeamCode;
  fixture: LiveSnapshot;
  followed: boolean;
  onAlert(): void;
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
        <div className="fixture-card-actions">
          {state !== "final" ? (
            <button
              className="fixture-alert-action"
              disabled={followed}
              onClick={onAlert}
              type="button"
            >
              {followed ? "Alerts on" : "Alert me"}
            </button>
          ) : null}
          <button onClick={onOpen} type="button">
            {state === "live" ? "Join live" : "Open companion"}
            <ArrowIcon />
          </button>
        </div>
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

function EmptySchedule() {
  return (
    <div className="empty-schedule">
      <p className="kicker">No fixtures returned</p>
      <h3>The tournament is quiet right now.</h3>
      <p>
        We will show scheduled, live, and completed matches as soon as TxLINE
        publishes them.
      </p>
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
  fixtureCount,
  installPrompt,
  onClose,
  onEnabled,
  team,
}: {
  fixtureCount: number;
  installPrompt: BeforeInstallPromptEvent | null;
  onClose(): void;
  onEnabled(): Promise<void>;
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
      await onEnabled();
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
        <p className="alert-target-copy">
          {fixtureCount > 0
            ? `${fixtureCount} ${fixtureCount === 1 ? "match" : "matches"} will be followed on this device.`
            : `Alerts are ready; follow a ${team.name} fixture when it appears.`}
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

function JudgedDemoLauncher({
  catalog,
  favoriteTeam,
  installPrompt,
  launchState,
  onBack,
  onLaunch,
}: {
  catalog: ProductCatalog;
  favoriteTeam: TeamCode;
  installPrompt: BeforeInstallPromptEvent | null;
  launchState: "idle" | "starting" | "error";
  onBack(): void;
  onLaunch(): void;
}) {
  const [alertState, setAlertState] = useState<
    "idle" | "working" | "done" | "error"
  >("idle");
  const supported = teamFor(favoriteTeam, catalog);
  const opponentCode =
    catalog.teams.find((team) => team.code !== favoriteTeam)?.code ??
    (favoriteTeam === "FRA" ? "ARG" : "FRA");
  const opponent = teamFor(opponentCode, catalog);

  const enableAndTestAlerts = async () => {
    const ios = /iPad|iPhone|iPod/u.test(navigator.userAgent);
    if (ios && !standalone()) {
      setAlertState("error");
      return;
    }
    setAlertState("working");
    try {
      if (installPrompt && !standalone()) {
        await installPrompt.prompt();
        if ((await installPrompt.userChoice).outcome === "dismissed") {
          setAlertState("idle");
          return;
        }
      }
      const configResponse = await fetch("/api/v1/push/config");
      if (!configResponse.ok) throw new Error("Push unavailable");
      const config = (await configResponse.json()) as {
        applicationServerKey?: unknown;
      };
      if (typeof config.applicationServerKey !== "string") {
        throw new Error("Push configuration is invalid");
      }
      await enableMomentPush({
        applicationServerKey: config.applicationServerKey,
      });
      setAlertState("done");
    } catch {
      setAlertState("error");
    }
  };

  return (
    <main className="app-canvas demo-launcher" id="main-content">
      <Masthead demo end="JUDGED DEMO · REAL PRODUCT FLOW" />
      <button className="back-button" onClick={onBack} type="button">
        <BackIcon /> Exit judged demo
      </button>
      <div className="demo-disclosure" role="status">
        <b>SERVER-OWNED EXPERIENCE MATCH</b>
        <span>
          Synthetic match facts stay clearly labelled, while notifications,
          Moments, commentary, Rooms and Memory use the production paths.
        </span>
      </div>

      <section className="today-hero demo-launcher-hero">
        <div>
          <p className="kicker">Your team · the complete five-minute journey</p>
          <h1>
            {supported.name} face {opponent.name}. Every product surface is
            live.
          </h1>
          <p>
            Arm real system alerts, launch the same Experience Match available
            from Today, then leave this PWA open, background it, or lock the
            device while the match runs itself.
          </p>
        </div>
        <div
          className="today-ticket-stamp"
          style={{ "--team": supported.primary } as CSSProperties}
        >
          <span>Your perspective</span>
          <b>
            <TeamFlag size="compact" team={supported} /> {supported.code}
          </b>
          <small>
            versus {opponent.code} · synthetic facts · production delivery
          </small>
        </div>
      </section>

      <section className="experience-grid demo-launcher-grid">
        <article className="experience-card">
          <p className="kicker">1 · Lock-screen proof</p>
          <h2>Use the browser&apos;s real permission and Web Push path.</h2>
          <p>
            MatchSense asks the operating system for permission. The confirmed
            goal inside this Experience is the server Web Push test, so tapping
            it opens a Moment that actually exists. No fake notification card is
            drawn here.
          </p>
          <button
            disabled={alertState === "working"}
            onClick={() => void enableAndTestAlerts()}
            type="button"
          >
            {alertState === "working"
              ? "Opening the real alert channel…"
              : alertState === "done"
                ? "Real alert channel armed"
                : "Enable & test real alerts"}
          </button>
          {alertState === "error" ? (
            <p className="inline-error" role="status">
              Install the PWA first on iPhone and allow notifications. You can
              still run the match and test Listening Mode.
            </p>
          ) : null}
        </article>

        <article className="experience-card experience-match-card">
          <p className="kicker">2 · Start one canonical match</p>
          <h2>Launch {supported.name}&apos;s complete Experience Match.</h2>
          <p>
            This creates the same durable five-minute fixture used by Today,
            exact Moment deep-links, commentary, Rooms and Match Memory.
          </p>
          <button
            disabled={launchState === "starting"}
            onClick={onLaunch}
            type="button"
          >
            {launchState === "starting"
              ? "Preparing your match…"
              : "Start the five-minute Experience Match"}{" "}
            <ArrowIcon />
          </button>
          {launchState === "error" ? (
            <p className="inline-error" role="status">
              The Experience Match could not start. Check the server connection
              and try again.
            </p>
          ) : null}
        </article>

        <article className="experience-card listening-card">
          <p className="kicker">3 · Continuous Listening Mode</p>
          <h2>Tap Start listening on the match screen.</h2>
          <p>
            The persistent MP3 channel and native media controls are the real
            production listener. Keep it playing when the PWA is backgrounded or
            the phone is locked.
          </p>
        </article>

        <article className="experience-card memory-card">
          <p className="kicker">4 · Tap back into truth</p>
          <h2>Open a real alert into its exact canonical Moment.</h2>
          <p>
            The score renders first, then motion and commentary. Full time
            produces the same Match Memory and Room result as the live product.
          </p>
        </article>
      </section>
      <Provenance label="JUDGED DEMO · SYNTHETIC FACTS · PRODUCTION PIPELINE" />
    </main>
  );
}

function formatDemoTime(seconds: number) {
  const clamped = Math.max(0, Math.min(300, Math.floor(seconds)));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}

function demoCueFrequency(type: DemoBeatType) {
  if (type === "winning_goal") return 720;
  if (type === "var_resolved" || type === "penalty_scored") return 620;
  if (type === "red_card" || type === "goal_overturned") return 180;
  if (type === "goal" || type === "yellow_card" || type === "var_started")
    return 310;
  return 440;
}

function demoVibration(type: DemoBeatType): number | number[] {
  if (type === "winning_goal" || type === "var_resolved") return [80, 45, 180];
  if (type === "red_card" || type === "goal_overturned") return [180, 70, 180];
  if (type === "goal" || type === "var_started") return [45, 55, 45, 55, 45];
  return 55;
}

function DemoCompanion({
  catalog,
  onBack,
}: {
  catalog: ProductCatalog;
  onBack(): void;
}) {
  const [state, dispatch] = useReducer(
    demoViewReducer,
    undefined,
    createDemoViewState,
  );
  const sessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sensoryEnabledRef = useRef(false);
  const completeRef = useRef(false);
  const argentina = teamFor("ARG", catalog, "Argentina");
  const france = teamFor("FRA", catalog, "France");

  const announceBeat = useCallback((event: DemoBeatEvent) => {
    if (!sensoryEnabledRef.current) return;
    const context = audioContextRef.current;
    if (context) {
      if (context.state === "suspended") void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = event.type.includes("card") ? "square" : "sine";
      oscillator.frequency.setValueAtTime(
        demoCueFrequency(event.type),
        context.currentTime,
      );
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.11, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.21);
    }
    navigator.vibrate?.(demoVibration(event.type));
    if (
      "speechSynthesis" in window &&
      typeof SpeechSynthesisUtterance !== "undefined"
    ) {
      window.speechSynthesis.cancel();
      const call = new SpeechSynthesisUtterance(event.description);
      call.lang = "en-GB";
      call.rate = 1.02;
      window.speechSynthesis.speak(call);
    }
  }, []);

  const connect = useCallback(
    (sessionId: string) => {
      streamRef.current?.close();
      completeRef.current = false;
      const stream = new EventSource(
        `/api/v1/demo/sessions/${encodeURIComponent(sessionId)}/stream`,
      );
      streamRef.current = stream;
      stream.addEventListener("demo.beat", ((raw: MessageEvent<string>) => {
        const event = parseDemoBeatEvent(raw.data);
        if (!event || event.sessionId !== sessionId) return;
        dispatch({ event, type: "beat" });
        announceBeat(event);
        if (event.type === "full_time") {
          completeRef.current = true;
          stream.close();
          if (streamRef.current === stream) streamRef.current = null;
        }
      }) as EventListener);
      stream.onerror = () => {
        if (!completeRef.current && stream.readyState === EventSource.CLOSED) {
          dispatch({
            message: "The simulation stream disconnected. Restart the match.",
            type: "error",
          });
        }
      };
    },
    [announceBeat],
  );

  useEffect(
    () => () => {
      sensoryEnabledRef.current = false;
      streamRef.current?.close();
      window.speechSynthesis?.cancel();
      if (audioContextRef.current) void audioContextRef.current.close();
    },
    [],
  );

  const enableForegroundSensory = () => {
    sensoryEnabledRef.current = true;
    if (typeof AudioContext !== "undefined") {
      if (!audioContextRef.current)
        audioContextRef.current = new AudioContext();
      void audioContextRef.current.resume();
    }
  };

  const start = async () => {
    enableForegroundSensory();
    dispatch({ type: "starting" });
    try {
      const response = await fetch("/api/v1/demo/sessions", { method: "POST" });
      if (!response.ok) throw new Error("Demo session unavailable");
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string" || body.id.length === 0)
        throw new Error("Demo session invalid");
      sessionIdRef.current = body.id;
      connect(body.id);
    } catch {
      dispatch({
        message: "The five-minute match could not start. Try again.",
        type: "error",
      });
    }
  };

  const restart = async () => {
    enableForegroundSensory();
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      await start();
      return;
    }
    streamRef.current?.close();
    streamRef.current = null;
    completeRef.current = false;
    dispatch({ type: "reset" });
    dispatch({ type: "starting" });
    try {
      const response = await fetch(
        `/api/v1/demo/sessions/${encodeURIComponent(sessionId)}/restart`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("Demo restart unavailable");
      connect(sessionId);
    } catch {
      dispatch({
        message: "The simulation could not restart. Try again.",
        type: "error",
      });
    }
  };

  const presentation = state.currentEvent
    ? demoEventPresentation(state.currentEvent.type)
    : null;
  const running = state.status === "starting" || state.status === "running";
  const controlLabel =
    state.status === "idle"
      ? "Start five-minute match"
      : state.status === "starting"
        ? "Starting match…"
        : state.status === "running"
          ? `Running · ${state.progress.current}/${state.progress.total}`
          : "Restart five-minute match";

  return (
    <main className="live-canvas demo-canvas" id="main-content">
      <Masthead demo end="SIMULATION · FIVE-MINUTE FINAL" />
      <button className="back-button" onClick={onBack} type="button">
        <BackIcon /> Exit demo
      </button>
      <div className="demo-disclosure" role="status">
        <b>DEMO · SIMULATION</b>
        <span>
          Scripted Argentina–France match · never mixed with live TxLINE
          fixtures
        </span>
      </div>

      <section className="demo-match-stage" aria-label="Demo match score">
        <div className="demo-progress-meta">
          <span>{state.phase}</span>
          <b>{formatDemoTime(state.progress.elapsedSeconds)} / 5:00</b>
        </div>
        <div
          aria-label={`${Math.round(state.progress.percent)} percent complete`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={state.progress.percent}
          className="demo-progress-track"
          role="progressbar"
        >
          <i style={{ width: `${state.progress.percent}%` }} />
        </div>
        <div className="score-grid demo-score-grid">
          <div>
            <TeamMark large team={argentina} />
            <span>
              <small>ARG</small>
              <b>Argentina</b>
            </span>
          </div>
          <div className="score-lockup">
            <span>{state.score.home}</span>
            <i>—</i>
            <span>{state.score.away}</span>
            <small>{state.minute}</small>
          </div>
          <div>
            <span>
              <small>FRA</small>
              <b>France</b>
            </span>
            <TeamMark large team={france} />
          </div>
        </div>

        <section
          aria-live="assertive"
          className="demo-cinematic-beat"
          data-tone={presentation?.tone ?? "neutral"}
          key={state.currentEvent?.id ?? "ready"}
        >
          {state.currentEvent && presentation ? (
            <>
              <div className="demo-beat-symbol" aria-hidden="true">
                {state.currentEvent.type === "goal_overturned"
                  ? "×"
                  : state.currentEvent.type === "red_card" ||
                      state.currentEvent.type === "yellow_card"
                    ? "■"
                    : state.currentEvent.type.startsWith("var")
                      ? "VAR"
                      : state.currentEvent.type === "reconnect_catchup"
                        ? "↻"
                        : "●"}
              </div>
              <div>
                <p>{presentation.eyebrow}</p>
                <h1>{presentation.title}</h1>
                <span>{state.currentEvent.description}</span>
              </div>
              <strong>{state.currentEvent.matchMinute}</strong>
            </>
          ) : (
            <div className="demo-ready-copy">
              <p>A complete MatchSense walkthrough</p>
              <h1>The final starts when you do.</h1>
              <span>
                Sixteen automatic beats: goals, cards, VAR, catch-up and full
                time.
              </span>
            </div>
          )}
        </section>
      </section>

      <section className="demo-command-deck">
        <div>
          <p className="kicker">Foreground match experience</p>
          <h2>One tap. Then the match runs itself.</h2>
          <p>
            This page uses browser speech, sound cues and vibration after your
            start gesture. These are in-app effects, not OS push notifications.
          </p>
        </div>
        <button
          className="primary-control"
          disabled={running}
          onClick={() => void (state.status === "idle" ? start() : restart())}
          type="button"
        >
          {controlLabel} <ArrowIcon />
        </button>
      </section>
      {state.error ? <p className="demo-stream-error">{state.error}</p> : null}

      <section className="demo-timeline-layout">
        <div className="timeline-panel">
          <div className="section-head">
            <span>Five-minute match wire</span>
            <b>
              {state.cursor} / {state.progress.total} beats
            </b>
          </div>
          {state.timeline.length ? (
            state.timeline.map((event) => {
              const eventCopy = demoEventPresentation(event.type);
              return (
                <article
                  className="demo-timeline-row"
                  data-tone={eventCopy.tone}
                  key={event.id}
                >
                  <span>{event.matchMinute}</span>
                  <div>
                    <b>{eventCopy.title}</b>
                    <small>{event.description}</small>
                  </div>
                  <em>
                    {event.score.home}—{event.score.away}
                  </em>
                </article>
              );
            })
          ) : (
            <p className="timeline-empty">
              Start the final and every beat will arrive here automatically.
            </p>
          )}
        </div>
        <aside className="demo-run-sheet">
          <span>What you will see</span>
          <ol>
            <li>Kickoff, pressure and cards</li>
            <li>A held goal and VAR stands</li>
            <li>A red card and penalty equalizer</li>
            <li>An overturned goal with score rollback</li>
            <li>Reconnect catch-up, winner and full time</li>
          </ol>
          <small>SIMULATION · ARGENTINA VS FRANCE · 5 MIN</small>
        </aside>
      </section>
      <Provenance label="SIMULATION · NOT LIVE MATCH DATA" />
    </main>
  );
}

function LiveCompanion({
  catalog,
  favoriteTeam,
  fixtureId,
  initialMomentIdentity,
  onBack,
  onCreateRoom,
  onMomentClose,
  onOpenMemory,
}: {
  catalog: ProductCatalog;
  favoriteTeam: TeamCode;
  fixtureId: string;
  initialMomentIdentity?: string;
  onBack(): void;
  onCreateRoom?: () => void;
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
  const [freshnessNow, setFreshnessNow] = useState(() =>
    new Date().toISOString(),
  );
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
    const loadInitialTruth = async () => {
      if (!initialMomentIdentity) {
        return {
          moment: null,
          snapshot: await fetchFixture(fixtureId, controller.signal),
          superseded: false,
        };
      }
      const resolution = await fetchMomentResolution(
        fixtureId,
        initialMomentIdentity,
        controller.signal,
      );
      return {
        moment: resolution.superseded
          ? (resolution.latest ?? resolution.requested)
          : (resolution.requested ?? resolution.latest),
        snapshot: resolution.snapshot,
        superseded: resolution.superseded,
      };
    };
    loadInitialTruth()
      .then(({ moment, snapshot, superseded }) => {
        if (!active) return;
        dispatch({ snapshot, type: "snapshot" });
        setLoadState("ready");
        if (initialMomentIdentity && moment) {
          dispatch({
            payload: {
              event: superseded ? "moment.revised" : "moment.created",
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

  const snapshot =
    state.snapshot.fixtureId === fixtureId ? state.snapshot : null;
  if (loadState === "loading" && !snapshot) {
    return <MatchLoading demo={false} onBack={onBack} />;
  }
  if (loadState === "error" && !snapshot) {
    return (
      <main className="live-canvas">
        <Masthead end="MATCH UNAVAILABLE" />
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
      <Masthead end={`TXLINE · ${state.transportHealth.toUpperCase()}`} />
      <button className="back-button" onClick={onBack} type="button">
        <BackIcon /> Today
      </button>
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
        <div className="control-rail-actions">
          <button
            className="primary-control"
            disabled={!prepared && !activeListening}
            onClick={startListening}
            type="button"
          >
            <SoundIcon /> {listeningLabel}
          </button>
          {onCreateRoom && shouldOfferRoomCreation(current) ? (
            <button
              className="quiet-button"
              onClick={onCreateRoom}
              type="button"
            >
              Create a Room for this match
            </button>
          ) : null}
        </div>
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

export function MomentOverlay({
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
  if (moment.celebratesGoal) {
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

function useLoadedMatchMemory(fixtureId: string) {
  const [view, setView] = useState<MatchMemoryView | null>(null);
  const [source, setSource] = useState<MemoryDataSource>("loading");
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    setView(null);
    setSource("loading");
    loadOneMemory({
      fetchRemote: (id) => fetchMatchMemory(id, controller.signal),
      fixtureId,
      readLocal: (id) => {
        const stored = readStoredMatch(id);
        return stored ? localMemoryView(stored) : null;
      },
      toView: matchMemoryView,
    })
      .then((result) => {
        setView(result.view);
        setSource(result.source);
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name === "AbortError") return;
        setError(true);
      });
    return () => controller.abort();
  }, [fixtureId]);

  return { error, source, view };
}

function MatchMemoryReplayScreen({
  catalog,
  favoriteTeam,
  fixtureId,
  onBack,
  onOpenMemory,
}: {
  catalog: ProductCatalog;
  favoriteTeam: TeamCode;
  fixtureId: string;
  onBack(): void;
  onOpenMemory(): void;
}) {
  const { error, source, view } = useLoadedMatchMemory(fixtureId);

  if (!view) {
    return (
      <main className="memory-replay-shell">
        <Masthead end="MATCH REPLAY" />
        {error ? (
          <DataError
            action="Back to history"
            detail="No persisted canonical timeline is available for this match."
            onRetry={onBack}
            title="This replay is not ready."
          />
        ) : (
          <>
            <MemorySourceNotice source={source} />
            <p className="memory-loading">
              Loading the canonical Moment timeline…
            </p>
          </>
        )}
      </main>
    );
  }

  const { moments, snapshot } = view;
  const home = teamFor(snapshot.homeTeam, catalog, snapshot.homeTeamName);
  const away = teamFor(snapshot.awayTeam, catalog, snapshot.awayTeamName);
  const supported = favoriteTeam === away.code ? away : home;

  if (fixtureState(snapshot) !== "final") {
    return (
      <main className="memory-replay-shell">
        <Masthead end="MATCH REPLAY" />
        <MemorySourceNotice source={source} />
        <section className="memory-locked">
          <p className="kicker">Canonical replay</p>
          <h1>This timeline is still being written.</h1>
          <p>
            Replay unlocks only after the source finalises the result. Until
            then, follow the live companion instead.
          </p>
          <button className="primary-control" onClick={onBack} type="button">
            Back to history
          </button>
        </section>
      </main>
    );
  }

  const replayMoments = [...moments]
    .sort((left, right) => left.revision - right.revision)
    .map((moment) => ({
      ...(moment.detail ? { detail: moment.detail } : {}),
      identity: moment.identity,
      kind: catchupKind(moment.kind),
      minute: moment.minute,
      score: moment.score,
      team: momentTeam(teamFor(moment.eventTeam, catalog)),
      title: eventLabel(moment),
    }));

  return (
    <main className="memory-replay-shell" id="main-content">
      <Masthead end="MATCH REPLAY" />
      <MemorySourceNotice source={source} />
      <MemoryReplayPlayer
        finalScore={scoreFor(snapshot, catalog)}
        key={fixtureId}
        moments={replayMoments}
        onBack={onBack}
        onOpenMemory={onOpenMemory}
        sourceLabel={snapshot.sourceLabel ?? "CANONICAL MATCH DATA"}
        summary={view.summary}
        supportedTeam={momentTeam(supported)}
      />
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
  const { error, source, view } = useLoadedMatchMemory(fixtureId);
  const [shared, setShared] = useState(false);
  if (!view) {
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
          <>
            <MemorySourceNotice source={source} />
            <p className="memory-loading">Gathering how the match felt…</p>
          </>
        )}
      </main>
    );
  }
  const { moments, snapshot } = view;
  const home = teamFor(snapshot.homeTeam, catalog, snapshot.homeTeamName);
  const away = teamFor(snapshot.awayTeam, catalog, snapshot.awayTeamName);
  const supported = favoriteTeam === away.code ? away : home;
  const final = fixtureState(snapshot) === "final";
  if (!final) {
    return (
      <main className="memory-shell">
        <Masthead end={snapshot.sourceLabel ?? "MATCH MEMORY"} />
        <MemorySourceNotice source={source} />
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
      <MemorySourceNotice source={source} />
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
        stats={view.stats}
        summary={
          source === "server"
            ? view.summary
            : `${supported.name}'s night: ${moments.length || "every"} locally saved Moment${moments.length === 1 ? "" : "s"}.`
        }
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

function localMemoryView(stored: StoredMatch): MatchMemoryView {
  return {
    moments: stored.moments,
    savedAt: stored.savedAt,
    snapshot: stored.snapshot,
    stats: [
      {
        away: stored.snapshot.score.away,
        home: stored.snapshot.score.home,
        label: "Goals",
      },
      { away: "—", home: "—", label: "Cards" },
      { away: "—", home: "—", label: "Corners" },
    ],
    summary: "This device's last saved copy of the match.",
  };
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
  const [entries, setEntries] = useState<MatchMemoryView[]>([]);
  const [source, setSource] = useState<MemoryDataSource>("loading");
  useEffect(() => {
    const controller = new AbortController();
    loadMemoryHistory({
      fetchRemote: () => fetchMatchMemories(controller.signal),
      readLocal: () => readStoredMatches().map(localMemoryView),
      toView: matchMemoryView,
    })
      .then((result) => {
        setEntries(result.entries);
        setSource(result.source);
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name === "AbortError") return;
        setEntries(readStoredMatches().map(localMemoryView));
        setSource("local-fallback");
      });
    return () => controller.abort();
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
          Final scores, canonical key Moments, and replay metadata follow your
          fan profile across devices.
        </p>
      </section>
      <MemorySourceNotice source={source} />
      {source === "loading" ? (
        <p className="memory-loading">Loading your saved match history…</p>
      ) : entries.length ? (
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
            {source === "server"
              ? "Follow a live fixture and MatchSense will keep its important turns with your fan profile."
              : "No previously saved match copy is available on this device."}
          </p>
          <button className="primary-control" onClick={onBack} type="button">
            Choose a match
          </button>
        </div>
      )}
    </main>
  );
}

const EXPERIENCE_TEAM_NAMES: Readonly<Record<string, string>> = {
  ARG: "Argentina",
  BRA: "Brazil",
  ENG: "England",
  ESP: "Spain",
  FRA: "France",
  JPN: "Japan",
};

function ExperienceFriendsSurface({
  catalog,
  fanId,
  favoriteTeam,
  navigate,
}: {
  catalog: ProductCatalog;
  fanId: string;
  favoriteTeam: TeamCode;
  navigate(path: string): void;
}) {
  const homeTeam = momentTeam(
    teamFor(
      favoriteTeam,
      catalog,
      EXPERIENCE_TEAM_NAMES[favoriteTeam] ?? favoriteTeam,
    ),
  );
  const catalogOpponents = catalog.teams.filter(
    (team) => team.code !== favoriteTeam,
  );
  const fallbackOpponentCode = favoriteTeam === "FRA" ? "ARG" : "FRA";
  const opponents = (
    catalogOpponents.length
      ? catalogOpponents
      : [
          fallbackTeam(
            fallbackOpponentCode,
            EXPERIENCE_TEAM_NAMES[fallbackOpponentCode] ?? fallbackOpponentCode,
          ),
        ]
  ).map(momentTeam);
  const fixture = {
    awayTeam: opponents[0]!,
    homeTeam,
    id: "experience:pending",
    isReplay: true,
    kickoffAt: new Date(Date.now() + 300_000).toISOString(),
  } satisfies RoomFixture;
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
  const defaultNickname =
    typeof window === "undefined"
      ? ""
      : (window.localStorage.getItem("matchsense.nickname") ?? "");
  return (
    <main className="rooms-shell" id="main-content">
      <RoomExperience
        api={roomApi}
        onExit={() => navigate("/")}
        onOpenMatch={(fixtureId) =>
          navigate(`/matches/${encodeURIComponent(fixtureId)}/live`)
        }
        onOpenRoom={(roomId) =>
          navigate(`/rooms/${encodeURIComponent(roomId)}`)
        }
        route={{
          defaultNickname,
          defaultRoomName: `${homeTeam.name} match night`,
          fixture,
          mode: "experience-create",
          opponents,
        }}
      />
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
    | { fixtureId?: string; mode: "create" }
    | { inviteCode: string; mode: "invite" }
    | { mode: "room"; roomId: string };
}) {
  const [fixture, setFixture] = useState<LiveSnapshot | null>(null);
  const [fixtureStateValue, setFixtureStateValue] = useState<
    "loading" | "ready" | "empty"
  >("loading");
  const createFixtureId =
    route.mode === "create" ? (route.fixtureId ?? null) : null;
  useEffect(() => {
    if (route.mode !== "create") return;
    resolveRoomCreationFixture(createFixtureId)
      .then((selectedFixture) => {
        setFixture(selectedFixture);
        setFixtureStateValue(selectedFixture ? "ready" : "empty");
      })
      .catch(() => setFixtureStateValue("empty"));
  }, [createFixtureId, route.mode]);
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
        <p className="memory-loading">
          {createFixtureId
            ? "Opening this match for your room…"
            : "Finding the next match for your room…"}
        </p>
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
  onRooms,
  onToday,
  onYou,
}: {
  active: "today" | "rooms" | "you";
  onRooms(): void;
  onToday(): void;
  onYou(): void;
}) {
  return (
    <nav className="app-nav" aria-label="Primary">
      <button data-active={active === "today"} onClick={onToday} type="button">
        Today
      </button>
      <button data-active={active === "rooms"} onClick={onRooms} type="button">
        Rooms
      </button>
      <button data-active={active === "you"} onClick={onYou} type="button">
        You
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
  return <TeamFlag size={large ? "hero" : "standard"} team={team} />;
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
