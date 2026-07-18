import { useEffect, useMemo, useState } from "react";

import { TeamFlag } from "../../components/TeamFlag.js";
import { FanAvatar, type FanCardDraft } from "../fan/FanSurfaces.js";
import type { FanProfile, FanProfileApi } from "../../fan-profile.js";
import type { ProductCatalog, ProductTeam } from "../../live-api.js";

import "./onboarding.css";

type OnboardingStage = "intro" | "team" | "handle" | "avatar";

export type OnboardingProfileApi = Pick<
  FanProfileApi,
  "checkHandle" | "updateProfile"
>;

export interface OnboardingFlowProps {
  catalog: ProductCatalog;
  catalogState?: "loading" | "ready" | "unavailable" | undefined;
  initialStage?: OnboardingStage | undefined;
  onComplete(profile: FanProfile): void;
  profileApi: OnboardingProfileApi;
}

function avatarVariants(team: ProductTeam) {
  return ["pulse", "terrace", "wave"].map(
    (variant) => `${team.code.toLowerCase()}-${variant}`,
  );
}

function teamFor(code: string | null, catalog: ProductCatalog) {
  return catalog.teams.find((team) => team.code === code) ?? null;
}

export function OnboardingFlow({
  catalog,
  catalogState = "ready",
  initialStage = "intro",
  onComplete,
  profileApi,
}: OnboardingFlowProps) {
  const [stage, setStage] = useState<OnboardingStage>(initialStage);
  const [teamCode, setTeamCode] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = useMemo(() => teamFor(teamCode, catalog), [catalog, teamCode]);

  useEffect(() => {
    if (stage !== "intro") return;
    const timer = window.setTimeout(() => setStage("team"), 3_600);
    return () => window.clearTimeout(timer);
  }, [stage]);

  const chooseTeam = (code: string) => {
    setTeamCode(code);
    setError(null);
    setStage("handle");
  };

  const reserveHandle = async () => {
    const candidate = handle.trim();
    if (!/^[A-Za-z0-9_]{3,24}$/u.test(candidate)) {
      setError("Use 3–24 letters, numbers, or underscores.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const availability = await profileApi.checkHandle(candidate);
      if (!availability.available) {
        setError("That supporter handle is already taken.");
        return;
      }
      setHandle(availability.handle);
      setStage("avatar");
    } catch {
      setError("We could not check that handle. Try again when connected.");
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async (avatarVariant: string) => {
    if (!team) return;
    setBusy(true);
    setError(null);
    const draft: FanCardDraft = {
      avatarVariant,
      favoriteTeam: team.code,
      handle,
    };
    try {
      const profile = await profileApi.updateProfile({
        ...draft,
        preferences: {
          captions: true,
          commentaryLanguage: "en",
        },
        profile: {},
      });
      onComplete(profile);
    } catch {
      setError("Your supporter card could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (stage === "intro") {
    return (
      <main className="ms-onboarding ms-onboarding--intro" id="main-content">
        <div aria-hidden="true" className="ms-onboarding-pitch">
          <i />
          <i />
          <i />
          <b>MS</b>
        </div>
        <div className="ms-onboarding-intro-copy" aria-live="polite">
          <p>MatchSense · World Cup companion</p>
          <h1>Every match has a pulse.</h1>
          <span>Follow the truth. Feel the moment.</span>
        </div>
        <button
          className="ms-onboarding-skip"
          onClick={() => setStage("team")}
          type="button"
        >
          Skip intro
        </button>
      </main>
    );
  }

  if (stage === "team") {
    return (
      <main className="ms-onboarding" id="main-content">
        <header className="ms-onboarding-header">
          <a
            aria-label="MatchSense home"
            className="ms-onboarding-wordmark"
            href="/"
          >
            Match<span>Sense</span>
          </a>
          <span>01 / 03 · supporter identity</span>
        </header>
        <section
          className="ms-onboarding-team-stage"
          aria-labelledby="team-title"
        >
          <div className="ms-onboarding-title">
            <p>Start with your colours</p>
            <h1 id="team-title">Who do you support?</h1>
            <span>
              Your team tunes the matches you see first. You can change it
              later.
            </span>
          </div>
          {catalogState === "loading" ? (
            <section className="ms-onboarding-unavailable" role="status">
              <p>Opening team catalogue</p>
              <span>
                MatchSense never invents a tournament team while the server is
                loading.
              </span>
            </section>
          ) : catalog.teams.length ? (
            <div className="ms-onboarding-team-grid" role="list">
              {catalog.teams.map((entry) => (
                <button
                  className="ms-onboarding-team-choice"
                  key={entry.code}
                  onClick={() => chooseTeam(entry.code)}
                  type="button"
                >
                  <TeamFlag size="hero" team={entry} />
                  <span>
                    <small>{entry.code}</small>
                    <b>{entry.name}</b>
                  </span>
                  <i aria-hidden="true">Choose</i>
                </button>
              ))}
            </div>
          ) : (
            <section className="ms-onboarding-unavailable" role="status">
              <p>Team catalogue unavailable</p>
              <span>
                MatchSense will show the real tournament teams once the server
                catalogue is available.
              </span>
            </section>
          )}
        </section>
      </main>
    );
  }

  if (!team) {
    return (
      <main className="ms-onboarding" id="main-content">
        <section className="ms-onboarding-unavailable" role="status">
          <p>Choose a team to continue</p>
          <button onClick={() => setStage("team")} type="button">
            Back to teams
          </button>
        </section>
      </main>
    );
  }

  if (stage === "handle") {
    return (
      <main className="ms-onboarding" id="main-content">
        <header className="ms-onboarding-header">
          <button onClick={() => setStage("team")} type="button">
            Back
          </button>
          <span>02 / 03 · supporter identity</span>
        </header>
        <section
          className="ms-onboarding-handle-stage"
          aria-labelledby="handle-title"
        >
          <aside>
            <TeamFlag size="hero" team={team} />
            <small>{team.code}</small>
            <b>{team.name}</b>
          </aside>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void reserveHandle();
            }}
          >
            <p>Known in every room</p>
            <h1 id="handle-title">Choose your MatchSense handle.</h1>
            <label>
              <span>Public supporter handle</span>
              <div className="ms-onboarding-handle-input">
                <b>@</b>
                <input
                  autoCapitalize="none"
                  autoComplete="username"
                  maxLength={24}
                  onChange={(event) => setHandle(event.target.value)}
                  placeholder="your_handle"
                  spellCheck={false}
                  value={handle}
                />
              </div>
            </label>
            <small>
              It is unique worldwide. Your internal fan ID is never displayed.
            </small>
            {error ? (
              <p className="ms-onboarding-error" role="alert">
                {error}
              </p>
            ) : null}
            <button
              className="ms-onboarding-primary"
              disabled={busy}
              type="submit"
            >
              {busy ? "Checking handle" : "Continue"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="ms-onboarding" id="main-content">
      <header className="ms-onboarding-header">
        <button onClick={() => setStage("handle")} type="button">
          Back
        </button>
        <span>03 / 03 · supporter identity</span>
      </header>
      <section
        className="ms-onboarding-avatar-stage"
        aria-labelledby="avatar-title"
      >
        <div>
          <p>Made from your colours</p>
          <h1 id="avatar-title">Pick your supporter mark.</h1>
          <span>It appears on your profile and future Room invitations.</span>
        </div>
        <div className="ms-onboarding-avatar-grid" role="list">
          {avatarVariants(team).map((variant) => (
            <button
              disabled={busy}
              key={variant}
              onClick={() => void saveProfile(variant)}
              type="button"
            >
              <FanAvatar handle={handle} team={team} variant={variant} />
              <span>{variant.split("-").at(-1)}</span>
            </button>
          ))}
        </div>
        {error ? (
          <p className="ms-onboarding-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
