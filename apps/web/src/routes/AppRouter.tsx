import { useCallback, useEffect, useMemo, useState } from "react";

import { TeamFlag } from "../components/TeamFlag.js";
import {
  createFanProfileApi,
  profileComplete,
  type FanProfile,
  type FanProfileApi,
} from "../fan-profile.js";
import { FanAvatar } from "../features/fan/FanSurfaces.js";
import {
  OnboardingFlow,
  type OnboardingProfileApi,
} from "../features/onboarding/OnboardingFlow.js";
import { MatchHub } from "../features/fixture/MatchHub.js";
import { TodayHub, type TodayHubState } from "../features/today/TodayHub.js";
import {
  createProductApi,
  type ProductApi,
  type ProductCatalog,
  type ProductTeam,
} from "../live-api.js";
import { normalizePath, type LiveSnapshot } from "../product-state.js";

import "./app-router.css";

type ResourceState = "loading" | "ready" | "unavailable";

const EMPTY_CATALOG: ProductCatalog = { teams: [] };

export interface AppRouterProps {
  initialCatalog?: ProductCatalog | undefined;
  initialFixtures?: readonly LiveSnapshot[] | undefined;
  /** Undefined means bootstrap from the server; null is a known guest profile. */
  initialProfile?: FanProfile | null | undefined;
  initialPath?: string | undefined;
  productApi?: ProductApi | undefined;
  profileApi?: FanProfileApi | undefined;
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
  return matched ? decodeURIComponent(matched[1] ?? "") : null;
}

function teamFor(
  catalog: ProductCatalog,
  code: string | null,
): ProductTeam | null {
  return catalog.teams.find((team) => team.code === code) ?? null;
}

function ProfileHub({
  catalog,
  onBack,
  profile,
}: {
  catalog: ProductCatalog;
  onBack(): void;
  profile: FanProfile;
}) {
  const team = teamFor(catalog, profile.favoriteTeam);
  return (
    <main className="ms-profile-hub" id="main-content">
      <header>
        <button onClick={onBack} type="button">
          Match day
        </button>
        <span>YOUR MATCHSENSE</span>
      </header>
      <section className="ms-profile-hub-card" aria-labelledby="profile-title">
        {team ? (
          <TeamFlag size="hero" team={team} />
        ) : (
          <span className="ms-profile-hub-mark" aria-hidden="true">
            MS
          </span>
        )}
        <div>
          <p>SUPPORTER PROFILE</p>
          <h1 id="profile-title">@{profile.handle ?? "supporter"}</h1>
          <span>
            {team
              ? `${team.name} supporter`
              : "Favourite team awaiting catalogue"}
          </span>
        </div>
        {team ? (
          <FanAvatar
            handle={profile.handle ?? "supporter"}
            team={team}
            variant={
              profile.avatarVariant ?? `${team.code.toLowerCase()}-pulse`
            }
          />
        ) : null}
      </section>
      <section className="ms-profile-hub-details" aria-label="Profile details">
        <article>
          <span>SUPPORTER ID</span>
          <b>{profile.id}</b>
          <p>
            This is the identity MatchSense uses for private follows and future
            Room invitations.
          </p>
        </article>
        <article>
          <span>FAVOURITE TEAM</span>
          <b>{team?.name ?? "Awaiting catalogue"}</b>
          <p>
            Your team is prioritised on Match Day when qualified fixtures are
            available.
          </p>
        </article>
      </section>
    </main>
  );
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
  initialPath,
  initialProfile,
  productApi,
  profileApi,
}: AppRouterProps) {
  const product = useMemo(() => productApi ?? createProductApi(), [productApi]);
  const profiles = useMemo(
    () => profileApi ?? createFanProfileApi(),
    [profileApi],
  );
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
  const selectedFixtureId = fixtureIdFrom(path);
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

  useEffect(() => {
    if (!selectedFixtureId || scheduledFixture) {
      setExactFixture(scheduledFixture);
      setExactFixtureState("ready");
      return;
    }
    const controller = new AbortController();
    setExactFixture(null);
    setExactFixtureState("loading");
    void product
      .fetchFixture(selectedFixtureId, controller.signal)
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
  }, [product, scheduledFixture, selectedFixtureId]);

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
        state={exactFixtureState}
      />
    );
  }

  if (path === "/you") {
    return (
      <ProfileHub
        catalog={catalog}
        onBack={() => navigate("/")}
        profile={profile}
      />
    );
  }

  return <UnsupportedRoute onBack={() => navigate("/")} />;
}
