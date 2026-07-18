export interface FanProfile {
  avatarVariant: string | null;
  createdAt: string;
  deletedAt: string | null;
  favoriteTeam: string | null;
  handle: string | null;
  handleNormalized: string | null;
  id: string;
  preferences: Record<string, unknown>;
  profile: Record<string, unknown>;
  updatedAt: string;
}

export interface FanFollow {
  eventPreferences: Record<string, unknown>;
  fixtureId: string;
  mode: "live";
}

export interface FanBootstrap {
  fan: FanProfile;
  follows: readonly FanFollow[];
  memories: readonly unknown[];
  rooms: readonly unknown[];
}

function normalizeFollow(value: unknown): FanFollow | null {
  const input = record(value);
  const fixtureId = stringOrNull(input?.fixtureId);
  const mode = input?.mode;
  if (!fixtureId || mode !== "live") return null;
  return {
    eventPreferences: object(input?.eventPreferences),
    fixtureId,
    mode,
  };
}

export interface FanProfileInput {
  avatarVariant: string;
  favoriteTeam: string;
  handle: string;
  preferences: Record<string, unknown>;
  profile: Record<string, unknown>;
}

export class FanProfileError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "FanProfileError";
    this.code = code;
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validFollowFixtureId(fixtureId: string) {
  return (
    fixtureId !== "." &&
    fixtureId !== ".." &&
    /^[A-Za-z0-9_.:-]{1,120}$/u.test(fixtureId)
  );
}

function object(value: unknown) {
  return record(value) ?? {};
}

function normalizeFan(value: unknown): FanProfile {
  const input = record(value);
  const id = stringOrNull(input?.id);
  if (!input || !id) throw new FanProfileError("profile_invalid", 502);
  return {
    avatarVariant: stringOrNull(input.avatarVariant),
    createdAt: stringOrNull(input.createdAt) ?? "",
    deletedAt: stringOrNull(input.deletedAt),
    favoriteTeam: stringOrNull(input.favoriteTeam)?.toUpperCase() ?? null,
    handle: stringOrNull(input.handle),
    handleNormalized: stringOrNull(input.handleNormalized),
    id,
    preferences: object(input.preferences),
    profile: object(input.profile),
    updatedAt: stringOrNull(input.updatedAt) ?? "",
  };
}

async function responseJson(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function failure(response: Response) {
  const payload = record(await responseJson(response));
  const code = stringOrNull(payload?.error) ?? "profile_request_failed";
  return new FanProfileError(code, response.status);
}

function csrfFromCookie(cookie: string) {
  for (const item of cookie.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name !== "matchsense_csrf") continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function defaultCookieSource() {
  return typeof document === "undefined" ? "" : document.cookie;
}

export function profileComplete(fan: FanProfile) {
  return Boolean(fan.favoriteTeam && fan.handle && fan.avatarVariant);
}

export function needsProfileCompletion(fan: FanProfile | null, path: string) {
  const deepLink =
    path.startsWith("/matches/") ||
    path.startsWith("/rooms/") ||
    path === "/rooms" ||
    path === "/history" ||
    path === "/you";
  return deepLink && (!fan || !profileComplete(fan));
}

export function createFanProfileApi(
  options: {
    cookieSource?: (() => string) | undefined;
    fetcher?: typeof fetch | undefined;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const cookieSource = options.cookieSource ?? defaultCookieSource;
  let issuedCsrf: string | null = null;

  const getBootstrap = async () => {
    const response = await fetcher("/api/v1/bootstrap", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await failure(response);
    const payload = record(await responseJson(response));
    if (!payload) throw new FanProfileError("bootstrap_invalid", 502);
    return {
      fan: normalizeFan(payload.fan),
      follows: Array.isArray(payload.follows)
        ? payload.follows.flatMap((value) => {
            const follow = normalizeFollow(value);
            return follow ? [follow] : [];
          })
        : [],
      memories: Array.isArray(payload.memories) ? payload.memories : [],
      rooms: Array.isArray(payload.rooms) ? payload.rooms : [],
    } satisfies FanBootstrap;
  };

  const createGuest = async () => {
    const response = await fetcher("/api/v1/session/guest", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "POST",
    });
    if (!response.ok) throw await failure(response);
    const payload = record(await responseJson(response));
    issuedCsrf = stringOrNull(payload?.csrfToken);
    return normalizeFan(payload?.fan);
  };

  const mutationHeaders = () => {
    const csrf = issuedCsrf ?? csrfFromCookie(cookieSource());
    if (!csrf) throw new FanProfileError("csrf_missing", 403);
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-matchsense-csrf": csrf,
    };
  };

  return {
    checkHandle: async (handle: string) => {
      const trimmed = handle.trim();
      if (!/^[A-Za-z0-9_]{3,24}$/u.test(trimmed)) {
        throw new FanProfileError("handle_invalid", 400);
      }
      const response = await fetcher(
        `/api/v1/profile/handles/${encodeURIComponent(trimmed)}/availability`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) throw await failure(response);
      const payload = record(await responseJson(response));
      return {
        available: payload?.available === true,
        handle: stringOrNull(payload?.handle) ?? trimmed,
      };
    },
    createGuest,
    deleteProfile: async () => {
      const response = await fetcher("/api/v1/profile", {
        credentials: "same-origin",
        headers: mutationHeaders(),
        method: "DELETE",
      });
      if (!response.ok) throw await failure(response);
    },
    ensureBootstrap: async () => {
      try {
        return await getBootstrap();
      } catch (error) {
        if (!(error instanceof FanProfileError) || error.status !== 401) {
          throw error;
        }
        await createGuest();
        return getBootstrap();
      }
    },
    followFixture: async (
      fixtureId: string,
      eventPreferences: Record<string, boolean> = {
        fullTime: true,
        goals: true,
        redCards: true,
      },
    ) => {
      if (!validFollowFixtureId(fixtureId)) {
        throw new FanProfileError("follow_invalid", 400);
      }
      const response = await fetcher(
        `/api/v1/follows/live/${encodeURIComponent(fixtureId)}`,
        {
          body: JSON.stringify({ eventPreferences }),
          credentials: "same-origin",
          headers: mutationHeaders(),
          method: "PUT",
        },
      );
      if (!response.ok) throw await failure(response);
    },
    getBootstrap,
    updateProfile: async (input: FanProfileInput) => {
      const response = await fetcher("/api/v1/profile", {
        body: JSON.stringify(input),
        credentials: "same-origin",
        headers: mutationHeaders(),
        method: "PATCH",
      });
      if (!response.ok) throw await failure(response);
      return normalizeFan(await responseJson(response));
    },
  };
}

export type FanProfileApi = ReturnType<typeof createFanProfileApi>;
