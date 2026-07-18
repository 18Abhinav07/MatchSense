import { useCallback, useEffect, useMemo, useState } from "react";

import { MemorySourceNotice } from "../MemorySourceNotice.js";
import {
  createFanProfileApi,
  profileComplete,
  type FanProfile,
  type FanProfileApi,
} from "../fan-profile.js";
import { ProfileSurface } from "../features/fan/FanSurfaces.js";
import { MemorySurface } from "../features/memory/MemorySurface.js";
import { MomentController } from "../features/moments/MomentController.js";
import {
  OnboardingFlow,
  type OnboardingProfileApi,
} from "../features/onboarding/OnboardingFlow.js";
import { MatchHub } from "../features/fixture/MatchHub.js";
import {
  RoomExperience,
  createCallThreeRoomApi,
  type CallThreeRoomApi,
  type CallThreeRoomView,
} from "../features/rooms/index.js";
import { RecordedReplayLibrary } from "../features/replay/RecordedReplayLibrary.js";
import { RecordedReplayScreen } from "../features/replay/RecordedReplayScreen.js";
import { TodayHub, type TodayHubState } from "../features/today/TodayHub.js";
import {
  createMomentResolutionApi,
  createProductApi,
  type MomentResolution,
  type MomentResolutionApi,
  type ProductApi,
  type ProductCatalog,
} from "../live-api.js";
import {
  createMemoryApi,
  type MemoryApi,
  type VerifiedFixtureMemory,
} from "../memory-api.js";
import { normalizePath, type LiveSnapshot } from "../product-state.js";
import {
  createRecordedReplayApi,
  type RecordedReplayApi,
  type RecordedReplayTimeline,
} from "../replay-api.js";

import "./app-router.css";

type ResourceState = "loading" | "ready" | "unavailable";

const EMPTY_CATALOG: ProductCatalog = { teams: [] };

export interface AppRouterProps {
  initialCatalog?: ProductCatalog | undefined;
  initialFixtures?: readonly LiveSnapshot[] | undefined;
  initialMemory?: VerifiedFixtureMemory | undefined;
  initialMomentResolution?: MomentResolution | undefined;
  /** Undefined means bootstrap from the server; null is a known guest profile. */
  initialProfile?: FanProfile | null | undefined;
  initialPath?: string | undefined;
  initialReplayHistory?: readonly LiveSnapshot[] | undefined;
  initialReplayTimeline?: RecordedReplayTimeline | undefined;
  initialRoom?: CallThreeRoomView | undefined;
  initialRooms?: readonly CallThreeRoomView[] | undefined;
  memoryApi?: MemoryApi | undefined;
  momentApi?: MomentResolutionApi | undefined;
  productApi?: ProductApi | undefined;
  profileApi?: FanProfileApi | undefined;
  replayApi?: RecordedReplayApi | undefined;
  roomApi?: CallThreeRoomApi | undefined;
}

function currentPath() {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

function publicPath(path: string) {
  const normalized = normalizePath(path);
  if (
    normalized === "/demo" ||
    normalized.startsWith("/demo/") ||
    normalized === "/experience" ||
    normalized.startsWith("/experience/")
  ) {
    return "/";
  }
  return normalized;
}

function fixtureIdFrom(path: string) {
  const matched = /^\/matches\/([^/]+)(?:\/live)?$/u.exec(path);
  return matched ? decodeRouteSegment(matched[1]) : null;
}

function decodeRouteSegment(value: string | undefined) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function memoryFixtureIdFrom(path: string) {
  const matched = /^\/matches\/([^/]+)\/memory$/u.exec(path);
  return matched ? decodeRouteSegment(matched[1]) : null;
}

function momentRouteFrom(path: string) {
  const matched = /^\/matches\/([^/]+)\/moments\/([^/]+)$/u.exec(path);
  const fixtureId = decodeRouteSegment(matched?.[1]);
  const identity = decodeRouteSegment(matched?.[2]);
  return fixtureId && identity ? { fixtureId, identity } : null;
}

function replaySessionIdFrom(path: string) {
  const matched = /^\/replays\/([^/]+)$/u.exec(path);
  return matched ? decodeRouteSegment(matched[1]) : null;
}

function roomCreateFixtureIdFrom(path: string) {
  const matched = /^\/rooms\/new\/([^/]+)$/u.exec(path);
  return matched ? decodeRouteSegment(matched[1]) : null;
}

function roomInviteCodeFrom(path: string) {
  const matched = /^\/rooms\/join\/([^/]+)$/u.exec(path);
  const inviteCode = decodeRouteSegment(matched?.[1]);
  return inviteCode && /^[A-Za-z0-9_-]{22}$/u.test(inviteCode)
    ? inviteCode
    : null;
}

function roomIdFrom(path: string) {
  const matched = /^\/rooms\/([^/]+)$/u.exec(path);
  const roomId = decodeRouteSegment(matched?.[1]);
  return roomId && /^[A-Za-z0-9_:.@-]+$/u.test(roomId) ? roomId : null;
}

function OpeningShell() {
  return (
    <main className="ms-router-opening" id="main-content" aria-live="polite">
      <span aria-hidden="true" />
      <p>Opening MatchSense</p>
      <small>Preparing your supporter profile without inventing a match.</small>
    </main>
  );
}

function UnavailableShell({ onRetry }: { onRetry(): void }) {
  return (
    <main className="ms-router-unavailable" id="main-content" role="status">
      <p>Your MatchSense profile is unavailable</p>
      <span>Reconnect to continue with your saved supporter identity.</span>
      <button onClick={onRetry} type="button">
        Try again
      </button>
    </main>
  );
}

function UnsupportedRoute({ onBack }: { onBack(): void }) {
  return (
    <main className="ms-router-unavailable" id="main-content" role="status">
      <p>This MatchSense surface is not ready yet</p>
      <span>
        Rooms, alerts, and replay controls only appear after their server-backed
        contracts are connected.
      </span>
      <button onClick={onBack} type="button">
        Back to match day
      </button>
    </main>
  );
}

export function AppRouter({
  initialCatalog,
  initialFixtures,
  initialMemory,
  initialMomentResolution,
  initialPath,
  initialProfile,
  initialReplayHistory,
  initialReplayTimeline,
  initialRoom,
  initialRooms,
  memoryApi,
  momentApi,
  productApi,
  profileApi,
  replayApi,
  roomApi,
}: AppRouterProps) {
  const product = useMemo(() => productApi ?? createProductApi(), [productApi]);
  const memoryClient = useMemo(
    () => memoryApi ?? createMemoryApi(),
    [memoryApi],
  );
  const moments = useMemo(
    () => momentApi ?? createMomentResolutionApi(),
    [momentApi],
  );
  const profiles = useMemo(
    () => profileApi ?? createFanProfileApi(),
    [profileApi],
  );
  const replays = useMemo(
    () => replayApi ?? createRecordedReplayApi(),
    [replayApi],
  );
  const rooms = useMemo(() => roomApi ?? createCallThreeRoomApi(), [roomApi]);
  const [path, setPath] = useState(() =>
    publicPath(initialPath ?? currentPath()),
  );
  const [reload, setReload] = useState(0);
  const [profile, setProfile] = useState<FanProfile | null>(
    initialProfile ?? null,
  );
  const [profileState, setProfileState] = useState<ResourceState>(
    initialProfile === undefined ? "loading" : "ready",
  );
  const [catalog, setCatalog] = useState<ProductCatalog>(
    initialCatalog ?? EMPTY_CATALOG,
  );
  const [catalogState, setCatalogState] = useState<ResourceState>(
    initialCatalog === undefined ? "loading" : "ready",
  );
  const [fixtures, setFixtures] = useState<readonly LiveSnapshot[]>(
    initialFixtures ?? [],
  );
  const [fixturesState, setFixturesState] = useState<ResourceState>(
    initialFixtures === undefined ? "loading" : "ready",
  );
  const [memory, setMemory] = useState<VerifiedFixtureMemory | null>(
    initialMemory ?? null,
  );
  const [memoryState, setMemoryState] = useState<ResourceState>(
    initialMemory === undefined ? "loading" : "ready",
  );
  const [momentResolution, setMomentResolution] =
    useState<MomentResolution | null>(initialMomentResolution ?? null);
  const [momentState, setMomentState] = useState<ResourceState>(
    initialMomentResolution === undefined ? "loading" : "ready",
  );
  const [replayHistory, setReplayHistory] = useState<readonly LiveSnapshot[]>(
    initialReplayHistory ?? [],
  );
  const [replayHistoryState, setReplayHistoryState] = useState<ResourceState>(
    initialReplayHistory === undefined ? "loading" : "ready",
  );
  const [replayTimeline, setReplayTimeline] =
    useState<RecordedReplayTimeline | null>(initialReplayTimeline ?? null);
  const [replayTimelineState, setReplayTimelineState] = useState<ResourceState>(
    initialReplayTimeline === undefined ? "loading" : "ready",
  );
  const [replayLaunchFailed, setReplayLaunchFailed] = useState(false);
  const selectedFixtureId = fixtureIdFrom(path);
  const memoryFixtureId = memoryFixtureIdFrom(path);
  const momentRoute = momentRouteFrom(path);
  const momentFixtureId = momentRoute?.fixtureId ?? null;
  const momentIdentity = momentRoute?.identity ?? null;
  const replaySessionId = replaySessionIdFrom(path);
  const roomCreateFixtureId = roomCreateFixtureIdFrom(path);
  const roomInviteCode = roomInviteCodeFrom(path);
  const roomId = roomIdFrom(path);
  const scheduledFixture =
    fixtures.find((fixture) => fixture.fixtureId === selectedFixtureId) ?? null;
  const [exactFixture, setExactFixture] = useState<LiveSnapshot | null>(null);
  const [exactFixtureState, setExactFixtureState] =
    useState<ResourceState>("ready");

  const navigate = useCallback((nextPath: string) => {
    const next = publicPath(nextPath);
    if (typeof window !== "undefined") window.history.pushState({}, "", next);
    setPath(next);
  }, []);

  const retry = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    const onPopState = () => setPath(publicPath(currentPath()));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (initialProfile !== undefined) return;
    let active = true;
    setProfileState("loading");
    void profiles
      .ensureBootstrap()
      .then((bootstrap) => {
        if (!active) return;
        setProfile(bootstrap.fan);
        setProfileState("ready");
      })
      .catch(() => {
        if (active) setProfileState("unavailable");
      });
    return () => {
      active = false;
    };
  }, [initialProfile, profiles, reload]);

  useEffect(() => {
    if (initialCatalog !== undefined) return;
    const controller = new AbortController();
    setCatalogState("loading");
    void product
      .fetchCatalog(controller.signal)
      .then((next) => {
        setCatalog(next);
        setCatalogState("ready");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setCatalogState("unavailable");
        }
      });
    return () => controller.abort();
  }, [initialCatalog, product, reload]);

  useEffect(() => {
    if (initialFixtures !== undefined) return;
    const controller = new AbortController();
    setFixturesState("loading");
    void product
      .fetchFixtures(controller.signal)
      .then((next) => {
        setFixtures(next);
        setFixturesState("ready");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setFixturesState("unavailable");
        }
      });
    return () => controller.abort();
  }, [initialFixtures, product, reload]);

  const requestedFixtureId = selectedFixtureId ?? roomCreateFixtureId;
  const requestedKnownFixture =
    fixtures.find((fixture) => fixture.fixtureId === requestedFixtureId) ??
    null;
  const roomCreationFixture = requestedKnownFixture ?? exactFixture;

  useEffect(() => {
    if (!requestedFixtureId || requestedKnownFixture) {
      setExactFixture(requestedKnownFixture);
      setExactFixtureState("ready");
      return;
    }
    const controller = new AbortController();
    setExactFixture(null);
    setExactFixtureState("loading");
    void product
      .fetchFixture(requestedFixtureId, controller.signal)
      .then((next) => {
        setExactFixture(next);
        setExactFixtureState("ready");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setExactFixtureState("unavailable");
        }
      });
    return () => controller.abort();
  }, [product, requestedFixtureId, requestedKnownFixture]);

  useEffect(() => {
    if (!memoryFixtureId) return;
    if (initialMemory?.fixture.fixtureId === memoryFixtureId) {
      setMemory(initialMemory);
      setMemoryState("ready");
      return;
    }
    const controller = new AbortController();
    setMemory(null);
    setMemoryState("loading");
    void memoryClient
      .fetchFixtureMemory(memoryFixtureId, controller.signal)
      .then((next) => {
        setMemory(next);
        setMemoryState("ready");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setMemoryState("unavailable");
        }
      });
    return () => controller.abort();
  }, [initialMemory, memoryClient, memoryFixtureId, reload]);

  useEffect(() => {
    if (!momentFixtureId || !momentIdentity) return;
    if (
      initialMomentResolution &&
      initialMomentResolution.snapshot.fixtureId === momentFixtureId
    ) {
      setMomentResolution(initialMomentResolution);
      setMomentState("ready");
      return;
    }
    const controller = new AbortController();
    setMomentResolution(null);
    setMomentState("loading");
    void moments
      .fetchMomentResolution(momentFixtureId, momentIdentity, controller.signal)
      .then((next) => {
        setMomentResolution(next);
        setMomentState("ready");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setMomentState("unavailable");
        }
      });
    return () => controller.abort();
  }, [
    initialMomentResolution,
    momentFixtureId,
    momentIdentity,
    moments,
    reload,
  ]);

  useEffect(() => {
    if (path !== "/replays") return;
    if (initialReplayHistory !== undefined) {
      setReplayHistory(initialReplayHistory);
      setReplayHistoryState("ready");
      return;
    }
    const controller = new AbortController();
    setReplayHistoryState("loading");
    void memoryClient
      .fetchHistory(controller.signal)
      .then((next) => {
        setReplayHistory(next);
        setReplayHistoryState("ready");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setReplayHistoryState("unavailable");
        }
      });
    return () => controller.abort();
  }, [initialReplayHistory, memoryClient, path, reload]);

  useEffect(() => {
    if (!replaySessionId) return;
    if (initialReplayTimeline?.id === replaySessionId) {
      setReplayTimeline(initialReplayTimeline);
      setReplayTimelineState("ready");
      return;
    }
    const controller = new AbortController();
    setReplayTimeline(null);
    setReplayTimelineState("loading");
    void replays
      .fetchTimeline(replaySessionId, controller.signal)
      .then((next) => {
        setReplayTimeline(next);
        setReplayTimelineState("ready");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setReplayTimelineState("unavailable");
        }
      });
    return () => controller.abort();
  }, [initialReplayTimeline, replaySessionId, replays, reload]);

  const openReplay = useCallback(
    (fixtureId: string) => {
      setReplayLaunchFailed(false);
      void replays
        .start(fixtureId)
        .then((session) =>
          navigate(`/replays/${encodeURIComponent(session.id)}`),
        )
        .catch(() => setReplayLaunchFailed(true));
    },
    [navigate, replays],
  );

  if (profileState === "loading") return <OpeningShell />;
  if (profileState === "unavailable")
    return <UnavailableShell onRetry={retry} />;

  if (!profile || !profileComplete(profile)) {
    return (
      <OnboardingFlow
        catalog={catalog}
        catalogState={catalogState}
        onComplete={(next) => {
          setProfile(next);
          navigate("/");
        }}
        profileApi={profiles as OnboardingProfileApi}
      />
    );
  }

  if (memoryFixtureId) {
    if (memoryState === "loading") {
      return (
        <main className="ms-router-unavailable" id="main-content">
          <MemorySourceNotice source="loading" />
        </main>
      );
    }
    if (memoryState === "unavailable" || !memory) {
      return (
        <main className="ms-router-unavailable" id="main-content">
          <MemorySourceNotice source="unavailable" />
          <button onClick={() => navigate("/replays")} type="button">
            Back to recorded replays
          </button>
        </main>
      );
    }
    return (
      <MemorySurface
        catalog={catalog}
        memory={memory}
        onBack={() => navigate("/replays")}
        onOpenReplay={openReplay}
      />
    );
  }

  if (momentFixtureId && momentIdentity) {
    if (momentState === "loading") {
      return (
        <main className="ms-router-unavailable" id="main-content" role="status">
          <p>Opening current Moment truth</p>
          <span>
            MatchSense will not animate an old notification before its current
            revision is known.
          </span>
        </main>
      );
    }
    if (momentState === "unavailable" || !momentResolution) {
      return (
        <main className="ms-router-unavailable" id="main-content" role="status">
          <p>Current Moment unavailable</p>
          <span>
            This link could not be reconciled with the current match revision.
          </span>
          <button
            onClick={() =>
              navigate(`/matches/${encodeURIComponent(momentFixtureId)}`)
            }
            type="button"
          >
            Open match truth
          </button>
        </main>
      );
    }
    return (
      <MomentController
        catalog={catalog}
        onClose={() =>
          navigate(`/matches/${encodeURIComponent(momentFixtureId)}`)
        }
        resolution={momentResolution}
      />
    );
  }

  if (path === "/replays") {
    return (
      <>
        <RecordedReplayLibrary
          catalog={catalog}
          fixtures={replayHistory}
          onBack={() => navigate("/")}
          onOpenMemory={(fixtureId) =>
            navigate(`/matches/${encodeURIComponent(fixtureId)}/memory`)
          }
          onOpenReplay={openReplay}
          state={replayHistoryState}
        />
        {replayLaunchFailed ? (
          <p className="ms-router-replay-error" role="status">
            This replay is no longer authorised or available from the archive.
          </p>
        ) : null}
      </>
    );
  }

  if (replaySessionId) {
    if (replayTimelineState === "loading") {
      return (
        <main className="ms-router-unavailable" id="main-content" role="status">
          <p>Opening recorded replay</p>
          <span>Loading the authorised archive in its recorded sequence.</span>
        </main>
      );
    }
    if (replayTimelineState === "unavailable" || !replayTimeline) {
      return (
        <main className="ms-router-unavailable" id="main-content" role="status">
          <p>Recorded replay unavailable</p>
          <span>
            MatchSense will not replace a missing archive with a simulated
            match.
          </span>
          <button onClick={() => navigate("/replays")} type="button">
            Back to recorded replays
          </button>
        </main>
      );
    }
    return (
      <RecordedReplayScreen
        catalog={catalog}
        onBack={() => navigate("/replays")}
        replay={replayTimeline}
      />
    );
  }

  if (path === "/rooms") {
    return (
      <RoomExperience
        api={rooms}
        defaultNickname={profile.handle ?? "supporter"}
        favoriteTeam={profile.favoriteTeam}
        onExit={() => navigate("/")}
        onOpenRoom={(id) => navigate(`/rooms/${encodeURIComponent(id)}`)}
        route={{
          ...(initialRooms ? { initialRooms } : {}),
          mode: "list",
        }}
        teams={catalog.teams}
      />
    );
  }

  if (roomCreateFixtureId) {
    if (exactFixtureState === "loading") {
      return (
        <main className="ms-router-unavailable" id="main-content" role="status">
          <p>Opening Call Three</p>
          <span>Checking the scheduled match against live TxLINE data.</span>
        </main>
      );
    }
    if (exactFixtureState === "unavailable" || !roomCreationFixture) {
      return (
        <main className="ms-router-unavailable" id="main-content" role="status">
          <p>Call Three unavailable</p>
          <span>
            This fixture could not be verified as an upcoming live match.
          </span>
          <button onClick={() => navigate("/")} type="button">
            Back to match day
          </button>
        </main>
      );
    }
    return (
      <RoomExperience
        api={rooms}
        defaultNickname={profile.handle ?? "supporter"}
        favoriteTeam={profile.favoriteTeam}
        onExit={() =>
          navigate(
            `/matches/${encodeURIComponent(roomCreationFixture.fixtureId)}`,
          )
        }
        onOpenRoom={(id) => navigate(`/rooms/${encodeURIComponent(id)}`)}
        route={{ fixture: roomCreationFixture, mode: "create" }}
        teams={catalog.teams}
      />
    );
  }

  if (roomInviteCode) {
    return (
      <RoomExperience
        api={rooms}
        defaultNickname={profile.handle ?? "supporter"}
        favoriteTeam={profile.favoriteTeam}
        onExit={() => navigate("/")}
        onOpenRoom={(id) => navigate(`/rooms/${encodeURIComponent(id)}`)}
        route={{ inviteCode: roomInviteCode, mode: "invite" }}
        teams={catalog.teams}
      />
    );
  }

  if (roomId) {
    return (
      <RoomExperience
        api={rooms}
        defaultNickname={profile.handle ?? "supporter"}
        favoriteTeam={profile.favoriteTeam}
        onExit={() => navigate("/rooms")}
        onOpenRoom={(id) => navigate(`/rooms/${encodeURIComponent(id)}`)}
        route={{
          ...(initialRoom?.id === roomId ? { initialRoom } : {}),
          mode: "room",
          roomId,
        }}
        teams={catalog.teams}
      />
    );
  }

  if (path === "/") {
    const todayState: TodayHubState =
      fixturesState === "loading"
        ? "loading"
        : fixturesState === "ready"
          ? "ready"
          : "unavailable";
    return (
      <TodayHub
        catalog={catalog}
        favoriteTeam={profile.favoriteTeam}
        fixtures={fixtures}
        onOpenFixture={(fixtureId) =>
          navigate(`/matches/${encodeURIComponent(fixtureId)}`)
        }
        onOpenProfile={() => navigate("/you")}
        onOpenReplays={() => navigate("/replays")}
        state={todayState}
      />
    );
  }

  if (selectedFixtureId) {
    return (
      <MatchHub
        catalog={catalog}
        favoriteTeam={profile.favoriteTeam}
        fixture={scheduledFixture ?? exactFixture}
        onBack={() => navigate("/")}
        onOpenMoment={(identity) => {
          if (!selectedFixtureId) return;
          navigate(
            `/matches/${encodeURIComponent(selectedFixtureId)}/moments/${encodeURIComponent(identity)}`,
          );
        }}
        state={exactFixtureState}
      />
    );
  }

  if (path === "/you") {
    return (
      <ProfileSurface
        api={profiles}
        catalog={catalog}
        fan={profile}
        onBack={() => navigate("/")}
        onDeleted={() => {
          setProfile(null);
          setProfileState("ready");
          navigate("/");
        }}
        onSaved={setProfile}
      />
    );
  }

  return <UnsupportedRoute onBack={() => navigate("/")} />;
}
