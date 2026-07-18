import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import { TeamFlag } from "../../components/TeamFlag.js";
import type { FanProfile, FanProfileApi } from "../../fan-profile.js";
import type { ProductCatalog, ProductTeam } from "../../live-api.js";

import "./fan-surfaces.css";

export interface FanCardDraft {
  avatarVariant: string;
  favoriteTeam: string;
  handle: string;
}

function avatarKey(team: ProductTeam, variant: string) {
  const suffix = variant.split("-").at(-1) ?? "pulse";
  return `${team.code.toLowerCase()}-${suffix}`;
}

function avatarVariants(team: ProductTeam) {
  return ["pulse", "terrace", "wave"].map(
    (variant) => `${team.code.toLowerCase()}-${variant}`,
  );
}

function initials(handle: string) {
  const pieces = handle
    .replace(/^@/u, "")
    .split(/[_\s-]+/u)
    .filter(Boolean);
  if (pieces.length > 1) {
    return `${pieces[0]?.[0] ?? "M"}${pieces[1]?.[0] ?? "S"}`.toUpperCase();
  }
  const compact = (pieces[0] ?? "MS").replace(/[^A-Za-z0-9]/gu, "");
  return `${compact[0] ?? "M"}${compact[1] ?? "S"}`.toUpperCase();
}

export function FanAvatar({
  handle,
  team,
  variant,
}: {
  handle: string;
  team: ProductTeam;
  variant: string;
}) {
  const kind = variant.split("-").at(-1) ?? "pulse";
  return (
    <span
      aria-label={`${handle || "MatchSense fan"} supporter avatar`}
      className="ms-fan-avatar"
      data-variant={kind}
      role="img"
      style={
        {
          "--fan-primary": team.primary,
          "--fan-secondary": team.secondary,
          "--fan-ink": team.foreground ?? "#f7f4ea",
        } as CSSProperties
      }
    >
      <i aria-hidden="true" />
      <b>{initials(handle)}</b>
    </span>
  );
}

export function FirstLaunchIntro({ onComplete }: { onComplete(): void }) {
  useEffect(() => {
    const timeout = window.setTimeout(onComplete, 3_500);
    return () => window.clearTimeout(timeout);
  }, [onComplete]);
  return (
    <main className="ms-intro" id="main-content">
      <div className="ms-intro-pitch" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>MS</span>
      </div>
      <div className="ms-intro-copy" aria-live="polite">
        <p>MatchSense · Live fan companion</p>
        <h1>EVERY MATCH HAS A PULSE.</h1>
        <span>Feel it. Hear it. Share it.</span>
      </div>
      <button className="ms-intro-skip" onClick={onComplete} type="button">
        Skip intro
      </button>
    </main>
  );
}

export function HandleStep({
  busy,
  error,
  onContinue,
  team,
}: {
  busy: boolean;
  error: string | null;
  onContinue(handle: string): void;
  team: ProductTeam;
}) {
  const [handle, setHandle] = useState("");
  const valid = /^[A-Za-z0-9_]{3,24}$/u.test(handle.trim());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) onContinue(handle.trim());
  };
  return (
    <main className="ms-identity-step" id="main-content">
      <header className="ms-step-mark">
        <span>02</span>
        <b>YOUR SUPPORTER CARD</b>
      </header>
      <section className="ms-identity-grid">
        <div className="ms-identity-team">
          <TeamFlag size="hero" team={team} />
          <small>{team.code}</small>
          <strong>{team.name}</strong>
        </div>
        <form onSubmit={submit}>
          <p className="kicker">Known in every room</p>
          <h1>Choose your MatchSense handle.</h1>
          <p>
            Friends see this name. Your private fan identity stays hidden and
            never changes.
          </p>
          <label className="ms-handle-field">
            <span>@</span>
            <input
              aria-label="Public MatchSense handle"
              autoCapitalize="none"
              autoComplete="username"
              maxLength={24}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="your_handle"
              spellCheck={false}
              value={handle}
            />
          </label>
          <small>
            3–24 letters, numbers, or underscores. Unique worldwide.
          </small>
          {error ? <p className="ms-fan-error">{error}</p> : null}
          <button className="primary-control" disabled={!valid || busy}>
            {busy ? "Checking…" : "Check handle"}
          </button>
        </form>
      </section>
    </main>
  );
}

export function AvatarStep({
  busy,
  error,
  handle,
  onChoose,
  team,
}: {
  busy: boolean;
  error: string | null;
  handle: string;
  onChoose(variant: string): void;
  team: ProductTeam;
}) {
  return (
    <main className="ms-avatar-step" id="main-content">
      <header className="ms-step-mark">
        <span>03</span>
        <b>YOUR SUPPORTER MARK</b>
      </header>
      <div className="ms-avatar-copy">
        <p className="kicker">No upload. Made from your colors.</p>
        <h1>Pick your supporter mark.</h1>
        <p>
          Your avatar follows you into Match Nights, reactions, and Memories.
        </p>
      </div>
      <div className="ms-avatar-options" role="list">
        {avatarVariants(team).map((variant) => (
          <button
            aria-label={`Choose ${variant} avatar`}
            disabled={busy}
            key={variant}
            onClick={() => onChoose(variant)}
            type="button"
          >
            <FanAvatar handle={handle} team={team} variant={variant} />
            <span>{variant}</span>
          </button>
        ))}
      </div>
      {error ? <p className="ms-fan-error">{error}</p> : null}
    </main>
  );
}

export function ProfileCompletionOverlay({
  busy,
  catalog,
  error,
  onComplete,
}: {
  busy: boolean;
  catalog: ProductCatalog;
  error: string | null;
  onComplete(draft: FanCardDraft): void;
}) {
  const teams = catalog.teams;
  const [teamCode, setTeamCode] = useState(teams[0]?.code ?? "");
  const [handle, setHandle] = useState("");
  const team = teams.find(({ code }) => code === teamCode) ?? null;
  const valid = /^[A-Za-z0-9_]{3,24}$/u.test(handle.trim());

  if (!team) {
    return (
      <div className="ms-completion-scrim">
        <section
          aria-label="Team catalogue unavailable"
          aria-modal="true"
          className="ms-completion-card"
          role="dialog"
        >
          <p className="kicker">Supporter identity</p>
          <h2>Team catalogue unavailable</h2>
          <p>
            MatchSense will not choose a team for you. Reconnect when the real
            tournament catalogue is available.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="ms-completion-scrim">
      <section
        aria-label="Complete fan profile"
        aria-modal="true"
        className="ms-completion-card"
        role="dialog"
      >
        <TeamFlag size="standard" team={team} />
        <p className="kicker">One quick fan card</p>
        <h2>Finish your fan card</h2>
        <p>
          Your destination is ready behind this card. Pick your colors and the
          handle friends will recognize.
        </p>
        <label>
          <span>Favorite team</span>
          <select
            onChange={(event) => setTeamCode(event.target.value)}
            value={team.code}
          >
            {teams.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Public handle</span>
          <input
            autoCapitalize="none"
            autoComplete="username"
            onChange={(event) => setHandle(event.target.value)}
            placeholder="@your_handle"
            value={handle}
          />
        </label>
        {error ? <p className="ms-fan-error">{error}</p> : null}
        <button
          className="primary-control"
          disabled={!valid || busy}
          onClick={() =>
            onComplete({
              avatarVariant: avatarKey(team, "pulse"),
              favoriteTeam: team.code,
              handle: handle.trim(),
            })
          }
          type="button"
        >
          {busy ? "Saving…" : "Continue to destination"}
        </button>
      </section>
    </div>
  );
}

function boolPreference(
  preferences: Record<string, unknown>,
  key: string,
  fallback: boolean,
) {
  return typeof preferences[key] === "boolean"
    ? (preferences[key] as boolean)
    : fallback;
}

function textPreference(
  preferences: Record<string, unknown>,
  key: string,
  fallback: string,
) {
  return typeof preferences[key] === "string"
    ? (preferences[key] as string)
    : fallback;
}

export function ProfileSurface({
  api,
  catalog,
  fan,
  onBack,
  onDeleted,
  onSaved,
}: {
  api: FanProfileApi;
  catalog: ProductCatalog;
  fan: FanProfile;
  onBack(): void;
  onDeleted(): void;
  onSaved(fan: FanProfile): void;
}) {
  const teams = catalog.teams;
  const [teamCode, setTeamCode] = useState(
    fan.favoriteTeam ?? teams[0]?.code ?? "",
  );
  const [handle, setHandle] = useState(fan.handle ?? "supporter");
  const [language, setLanguage] = useState(() =>
    textPreference(fan.preferences, "commentaryLanguage", "en"),
  );
  const [voice, setVoice] = useState(() =>
    textPreference(fan.preferences, "commentaryVoice", "stadium"),
  );
  const [goals, setGoals] = useState(() =>
    boolPreference(fan.preferences, "alertsGoals", true),
  );
  const [reds, setReds] = useState(() =>
    boolPreference(fan.preferences, "alertsRedCards", true),
  );
  const [fullTime, setFullTime] = useState(() =>
    boolPreference(fan.preferences, "alertsFullTime", true),
  );
  const [reducedMotion, setReducedMotion] = useState(() =>
    boolPreference(fan.preferences, "reducedMotion", false),
  );
  const [captions, setCaptions] = useState(() =>
    boolPreference(fan.preferences, "captions", true),
  );
  const [state, setState] = useState<
    "idle" | "saving" | "saved" | "error" | "confirm-delete" | "deleting"
  >("idle");
  const team = teams.find(({ code }) => code === teamCode) ?? null;
  const avatarVariant = useMemo(
    () => (team ? avatarKey(team, fan.avatarVariant ?? "pulse") : ""),
    [fan.avatarVariant, team],
  );

  const save = async () => {
    if (!team) return;
    setState("saving");
    try {
      const updated = await api.updateProfile({
        avatarVariant,
        favoriteTeam: team.code,
        handle: handle.trim(),
        preferences: {
          ...fan.preferences,
          alertsFullTime: fullTime,
          alertsGoals: goals,
          alertsRedCards: reds,
          captions,
          commentaryLanguage: language,
          commentaryVoice: voice,
          reducedMotion,
        },
        profile: fan.profile,
      });
      onSaved(updated);
      setState("saved");
    } catch {
      setState("error");
    }
  };

  const remove = async () => {
    if (state !== "confirm-delete") {
      setState("confirm-delete");
      return;
    }
    setState("deleting");
    try {
      await api.deleteProfile();
      onDeleted();
    } catch {
      setState("error");
    }
  };

  if (!team) {
    return (
      <main className="ms-profile" id="main-content">
        <header className="ms-profile-header">
          <button onClick={onBack} type="button">
            ← Today
          </button>
          <span>YOU · PRIVATE FAN PROFILE</span>
        </header>
        <section className="ms-router-unavailable" role="status">
          <p>
            {teams.length
              ? "Saved team unavailable"
              : "Team catalogue unavailable"}
          </p>
          <span>
            {teams.length
              ? "MatchSense will not replace your saved team. Choose a real team to continue."
              : "MatchSense will not replace your saved team with an invented team. Reconnect when the real tournament catalogue is available."}
          </span>
          {teams.length ? (
            <label>
              <span>Favorite team</span>
              <select
                aria-label="Choose a real team"
                onChange={(event) => setTeamCode(event.target.value)}
                value=""
              >
                <option disabled value="">
                  Choose a real team
                </option>
                {teams.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="ms-profile" id="main-content">
      <header className="ms-profile-header">
        <button onClick={onBack} type="button">
          ← Today
        </button>
        <span>YOU · PRIVATE FAN PROFILE</span>
      </header>
      <section className="ms-profile-hero">
        <FanAvatar handle={handle} team={team} variant={avatarVariant} />
        <div>
          <p className="kicker">SUPPORTER PROFILE</p>
          <h1>This is your MatchSense.</h1>
          <strong>@{handle}</strong>
          <span>
            <TeamFlag size="compact" team={team} /> {team.name}
          </span>
          <small>SUPPORTER ID · {fan.id}</small>
        </div>
      </section>
      <section className="ms-profile-grid">
        <article>
          <p className="kicker">Identity</p>
          <label>
            <span>Public handle</span>
            <input
              autoComplete="username"
              onChange={(event) => setHandle(event.target.value)}
              value={handle}
            />
          </label>
          <label>
            <span>Favorite team</span>
            <select
              onChange={(event) => setTeamCode(event.target.value)}
              value={team.code}
            >
              {teams.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        </article>
        <article>
          <p className="kicker">Match alerts</p>
          <Toggle checked={goals} label="Goals" onChange={setGoals} />
          <Toggle checked={reds} label="Red cards" onChange={setReds} />
          <Toggle checked={fullTime} label="Full-time" onChange={setFullTime} />
        </article>
        <article>
          <p className="kicker">Listening Mode</p>
          <label>
            <span>Commentary language</span>
            <select
              onChange={(event) => setLanguage(event.target.value)}
              value={language}
            >
              <option value="en">English</option>
              <option value="hi">Hindi</option>
              <option value="es">Spanish</option>
            </select>
          </label>
          <label>
            <span>Voice</span>
            <select
              onChange={(event) => setVoice(event.target.value)}
              value={voice}
            >
              <option value="stadium">Stadium</option>
              <option value="calm">Calm radio</option>
            </select>
          </label>
        </article>
        <article>
          <p className="kicker">Accessibility</p>
          <Toggle
            checked={reducedMotion}
            label="Reduced motion"
            onChange={setReducedMotion}
          />
          <Toggle
            checked={captions}
            label="Always show captions"
            onChange={setCaptions}
          />
        </article>
      </section>
      <div className="ms-profile-actions">
        <button
          className="primary-control"
          onClick={() => void save()}
          type="button"
        >
          {state === "saving"
            ? "Saving…"
            : state === "saved"
              ? "Profile saved"
              : "Save profile"}
        </button>
        <button
          className="ms-delete-profile"
          onClick={() => void remove()}
          type="button"
        >
          {state === "confirm-delete"
            ? "Tap again to delete everything"
            : state === "deleting"
              ? "Deleting…"
              : "Delete profile"}
        </button>
        {state === "error" ? (
          <p className="ms-fan-error">
            Your profile could not be updated. Try again.
          </p>
        ) : null}
      </div>
    </main>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange(value: boolean): void;
}) {
  return (
    <label className="ms-profile-toggle">
      <span>{label}</span>
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <i aria-hidden="true" />
    </label>
  );
}
