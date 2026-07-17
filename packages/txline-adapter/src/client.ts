export const VERIFIED_TXLINE_DEVNET_ENDPOINTS = {
  fixtureSnapshotPath: "/api/fixtures/snapshot",
  guestSessionPath: "/auth/guest/start",
  historicalScorePath: (fixtureId: string) =>
    `/api/scores/historical/${encodeURIComponent(fixtureId)}`,
  origin: "https://txline-dev.txodds.com",
  scoresStreamPath: "/api/scores/stream",
} as const;

export class TxlineHttpError extends Error {
  override readonly name = "TxlineHttpError";

  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`TxLINE ${path} returned HTTP ${status}`);
  }
}

export type TxlineAuthenticationReason = "initial" | "renewal";

export interface TxlineAuthenticationEvent {
  reason: TxlineAuthenticationReason;
}

export interface TxlineAuthenticationOptions {
  onAuthenticating?: ((event: TxlineAuthenticationEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface TxlineAuthenticatedGetOptions {
  accept?: string | undefined;
  lastEventId?: string | null | undefined;
  onAuthenticating?: ((event: TxlineAuthenticationEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface TxlineAuthenticatedClient {
  get(path: string, options?: TxlineAuthenticatedGetOptions): Promise<Response>;
  prepare(options?: TxlineAuthenticationOptions): Promise<void>;
}

export interface TxlineAuthenticatedClientOptions {
  apiToken: string;
  fetchImpl?: typeof fetch | undefined;
  origin?: string | undefined;
}

type JsonObject = Record<string, unknown>;

interface TxlineAuthenticationFlight {
  controller: AbortController;
  promise: Promise<string>;
  settled: boolean;
  waiters: Set<symbol>;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup must never replace the provider HTTP error.
  }
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

export function createTxlineAuthenticatedClient(
  options: TxlineAuthenticatedClientOptions,
): TxlineAuthenticatedClient {
  const apiToken = options.apiToken.trim();
  if (apiToken.length === 0) throw new Error("TxLINE API token is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = (
    options.origin ?? VERIFIED_TXLINE_DEVNET_ENDPOINTS.origin
  ).replace(/\/$/u, "");
  let guestJwt: string | null = null;
  let guestFlight: TxlineAuthenticationFlight | null = null;

  const startAuthentication = (
    authenticationOptions: TxlineAuthenticationOptions,
    reason: TxlineAuthenticationReason,
  ) => {
    authenticationOptions.onAuthenticating?.({ reason });
    const flight: TxlineAuthenticationFlight = {
      controller: new AbortController(),
      promise: Promise.resolve(""),
      settled: false,
      waiters: new Set(),
    };
    flight.promise = (async () => {
      const response = await fetchImpl(
        `${origin}${VERIFIED_TXLINE_DEVNET_ENDPOINTS.guestSessionPath}`,
        {
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: flight.controller.signal,
        },
      );
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new TxlineHttpError(
          response.status,
          VERIFIED_TXLINE_DEVNET_ENDPOINTS.guestSessionPath,
        );
      }
      const payload: unknown = await response.json();
      const token = isObject(payload) ? payload.token : null;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("TxLINE guest session returned no JWT");
      }
      if (guestFlight === flight && !flight.controller.signal.aborted) {
        guestJwt = token;
      }
      return token;
    })();
    guestFlight = flight;
    void flight.promise.then(
      () => {
        flight.settled = true;
        if (guestFlight === flight) guestFlight = null;
      },
      () => {
        flight.settled = true;
        if (guestFlight === flight) guestFlight = null;
      },
    );
    return flight;
  };

  const waitForAuthentication = (
    flight: TxlineAuthenticationFlight,
    signal: AbortSignal | undefined,
  ) => {
    const waiter = Symbol("txline-auth-waiter");
    flight.waiters.add(waiter);
    return new Promise<string>((resolve, reject) => {
      let finished = false;
      const detach = () => {
        signal?.removeEventListener("abort", onAbort);
        flight.waiters.delete(waiter);
      };
      const onAbort = () => {
        if (finished || signal === undefined) return;
        finished = true;
        detach();
        if (!flight.settled && flight.waiters.size === 0) {
          if (guestFlight === flight) guestFlight = null;
          flight.controller.abort();
        }
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void flight.promise.then(
        (token) => {
          if (finished) return;
          finished = true;
          detach();
          resolve(token);
        },
        (error: unknown) => {
          if (finished) return;
          finished = true;
          detach();
          reject(error);
        },
      );
    });
  };

  const authenticate = async (
    authenticationOptions: TxlineAuthenticationOptions,
    reason: TxlineAuthenticationReason,
  ) => {
    if (authenticationOptions.signal?.aborted) {
      throw abortReason(authenticationOptions.signal);
    }
    if (guestJwt !== null) return guestJwt;
    const flight =
      guestFlight ?? startAuthentication(authenticationOptions, reason);
    return waitForAuthentication(flight, authenticationOptions.signal);
  };

  const request = async (
    path: string,
    requestOptions: TxlineAuthenticatedGetOptions,
    jwt: string,
  ) => {
    const headers = new Headers({
      Accept: requestOptions.accept ?? "text/event-stream, application/json",
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": apiToken,
    });
    if (
      requestOptions.lastEventId !== null &&
      requestOptions.lastEventId !== undefined
    ) {
      headers.set("Last-Event-ID", requestOptions.lastEventId);
    }
    return fetchImpl(`${origin}${path}`, {
      headers,
      method: "GET",
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
  };

  return {
    async get(path, requestOptions = {}) {
      if (!path.startsWith("/")) {
        throw new Error("TxLINE request path must start with /");
      }
      let jwt = await authenticate(requestOptions, "initial");
      let response = await request(path, requestOptions, jwt);
      if (response.status === 401) {
        await cancelResponseBody(response);
        if (guestJwt === jwt) guestJwt = null;
        jwt = await authenticate(requestOptions, "renewal");
        response = await request(path, requestOptions, jwt);
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new TxlineHttpError(response.status, path);
      }
      return response;
    },
    async prepare(authenticationOptions = {}) {
      await authenticate(authenticationOptions, "initial");
    },
  };
}
