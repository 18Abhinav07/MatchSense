import { describe, expect, it, vi } from "vitest";

import { createTxlineAuthenticatedClient } from "./client.js";

function cancellableErrorResponse(
  status: number,
  onCancel: () => void,
  cancelError?: Error,
) {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        onCancel();
        if (cancelError) throw cancelError;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode("provider error"));
      },
    }),
    { status },
  );
}

describe("authenticated TxLINE client", () => {
  it("lazily creates one guest JWT and shares it across protected requests", async () => {
    const requests: Array<{
      apiToken: string | null;
      authorization: string | null;
      url: string;
    }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        apiToken: headers.get("X-Api-Token"),
        authorization: headers.get("Authorization"),
        url,
      });
      if (url.endsWith("/auth/guest/start")) {
        return new Response(JSON.stringify({ token: "fixture-guest-jwt" }), {
          status: 200,
        });
      }
      return new Response("[]", { status: 200 });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });
    const authenticationReasons: string[] = [];

    expect(requests).toEqual([]);
    await client.prepare({
      onAuthenticating: ({ reason }) => authenticationReasons.push(reason),
    });
    await client.get("/api/fixtures/snapshot?competitionId=72");
    await client.get("/api/scores/historical/18257739");
    await client.get("/api/scores/stream");
    await client.prepare({
      onAuthenticating: ({ reason }) => authenticationReasons.push(reason),
    });

    expect(
      requests.filter(({ url }) => url.endsWith("/auth/guest/start")),
    ).toHaveLength(1);
    expect(authenticationReasons).toEqual(["initial"]);
    expect(
      requests
        .filter(({ url }) => !url.endsWith("/auth/guest/start"))
        .map(({ authorization }) => authorization),
    ).toEqual([
      "Bearer fixture-guest-jwt",
      "Bearer fixture-guest-jwt",
      "Bearer fixture-guest-jwt",
    ]);
    expect(
      requests
        .filter(({ url }) => !url.endsWith("/auth/guest/start"))
        .map(({ apiToken }) => apiToken),
    ).toEqual([
      "fixture-activated-server-token",
      "fixture-activated-server-token",
      "fixture-activated-server-token",
    ]);
    expect(client).not.toHaveProperty("apiToken");
  });

  it("renews once after a protected request returns 401", async () => {
    let authCount = 0;
    let protectedCount = 0;
    const authorizations: Array<string | null> = [];
    const authenticationReasons: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        authCount += 1;
        const jwt = `fixture-jwt-${authCount}`;
        return new Response(JSON.stringify({ token: jwt }), {
          status: 200,
        });
      }
      protectedCount += 1;
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      return protectedCount === 1
        ? new Response(null, { status: 401 })
        : new Response("[]", { status: 200 });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    await expect(
      client.get("/api/fixtures/snapshot", {
        onAuthenticating: ({ reason }) => authenticationReasons.push(reason),
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(authCount).toBe(2);
    expect(authenticationReasons).toEqual(["initial", "renewal"]);
    expect(authorizations).toEqual([
      "Bearer fixture-jwt-1",
      "Bearer fixture-jwt-2",
    ]);
  });

  it("treats a second 401 as fatal instead of renewing forever", async () => {
    let authCount = 0;
    let protectedCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        authCount += 1;
        const jwt = `fixture-jwt-${authCount}`;
        return new Response(JSON.stringify({ token: jwt }), {
          status: 200,
        });
      }
      protectedCount += 1;
      return new Response(null, { status: 401 });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    await expect(client.get("/api/scores/stream")).rejects.toEqual(
      expect.objectContaining({
        name: "TxlineHttpError",
        status: 401,
      }),
    );
    expect(authCount).toBe(2);
    expect(protectedCount).toBe(2);
  });

  it("treats 403 as fatal without renewing the guest JWT", async () => {
    let authCount = 0;
    let protectedCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        authCount += 1;
        return new Response(JSON.stringify({ token: "fixture-guest-jwt" }), {
          status: 200,
        });
      }
      protectedCount += 1;
      return new Response(null, { status: 403 });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    await expect(client.get("/api/scores/stream")).rejects.toEqual(
      expect.objectContaining({
        name: "TxlineHttpError",
        status: 403,
      }),
    );
    expect(authCount).toBe(1);
    expect(protectedCount).toBe(1);
  });

  it("isolates a leader abort from a follower sharing the same guest request", async () => {
    const leaderController = new AbortController();
    const followerController = new AbortController();
    const authentication = {
      internalSignal: null as AbortSignal | null,
      resolve: null as ((response: Response) => void) | null,
    };
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      authentication.internalSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((resolve) => {
        authentication.resolve = resolve;
      });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    const leader = client.prepare({ signal: leaderController.signal });
    const follower = client.prepare({ signal: followerController.signal });
    leaderController.abort();

    await expect(leader).rejects.toMatchObject({ name: "AbortError" });
    expect(authentication.internalSignal?.aborted).toBe(false);
    authentication.resolve?.(
      new Response(JSON.stringify({ token: "fixture-shared-jwt" }), {
        status: 200,
      }),
    );
    await expect(follower).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lets a follower abort promptly while the leader authentication continues", async () => {
    const followerController = new AbortController();
    const authentication = {
      internalSignal: null as AbortSignal | null,
      resolve: null as ((response: Response) => void) | null,
    };
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      authentication.internalSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((resolve) => {
        authentication.resolve = resolve;
      });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    const leader = client.prepare();
    const follower = client.prepare({ signal: followerController.signal });
    followerController.abort();

    await expect(follower).rejects.toMatchObject({ name: "AbortError" });
    expect(authentication.internalSignal?.aborted).toBe(false);
    authentication.resolve?.(
      new Response(JSON.stringify({ token: "fixture-shared-jwt" }), {
        status: 200,
      }),
    );
    await expect(leader).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels the shared guest request only after every active waiter aborts", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const authentication = { internalSignal: null as AbortSignal | null };
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      authentication.internalSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        authentication.internalSignal?.addEventListener(
          "abort",
          () => reject(authentication.internalSignal?.reason),
          { once: true },
        );
      });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    const first = client.prepare({ signal: firstController.signal });
    const second = client.prepare({ signal: secondController.signal });
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(authentication.internalSignal?.aborted).toBe(false);
    secondController.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(authentication.internalSignal?.aborted).toBe(true);
  });

  it("starts a fresh guest request for a caller arriving after every prior waiter aborts", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let authenticationAttempt = 0;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      authenticationAttempt += 1;
      if (authenticationAttempt === 1) {
        const internalSignal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          internalSignal.addEventListener(
            "abort",
            () => reject(internalSignal.reason),
            { once: true },
          );
        });
      }
      return new Response(
        JSON.stringify({ token: "fixture-replacement-jwt" }),
        { status: 200 },
      );
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    const first = client.prepare({ signal: firstController.signal });
    const second = client.prepare({ signal: secondController.signal });
    firstController.abort();
    secondController.abort();
    const replacement = client.prepare();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    await expect(replacement).resolves.toBeUndefined();
    expect(authenticationAttempt).toBe(2);
  });

  it("does not let an abandoned authentication overwrite a newer JWT", async () => {
    const firstController = new AbortController();
    const authResolvers: Array<(response: Response) => void> = [];
    const protectedAuthorizations: Array<string | null> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        return await new Promise<Response>((resolve) => {
          authResolvers.push(resolve);
        });
      }
      protectedAuthorizations.push(
        new Headers(init?.headers).get("Authorization"),
      );
      return new Response("[]", { status: 200 });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    const abandoned = client.prepare({ signal: firstController.signal });
    firstController.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });

    const replacement = client.prepare();
    authResolvers[1]?.(
      new Response(JSON.stringify({ token: "fixture-current-jwt" }), {
        status: 200,
      }),
    );
    await replacement;

    authResolvers[0]?.(
      new Response(JSON.stringify({ token: "fixture-stale-jwt" }), {
        status: 200,
      }),
    );
    await Promise.resolve();
    await client.get("/api/fixtures/snapshot");

    expect(protectedAuthorizations).toEqual(["Bearer fixture-current-jwt"]);
  });

  it("cancels every non-OK response body before retrying or throwing", async () => {
    let authCount = 0;
    let protectedCount = 0;
    let cancellationCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        authCount += 1;
        const jwt = `fixture-body-jwt-${authCount}`;
        return new Response(JSON.stringify({ token: jwt }), { status: 200 });
      }
      protectedCount += 1;
      return cancellableErrorResponse(protectedCount === 1 ? 401 : 403, () => {
        cancellationCount += 1;
      });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    await expect(client.get("/api/scores/stream")).rejects.toMatchObject({
      name: "TxlineHttpError",
      status: 403,
    });
    expect(authCount).toBe(2);
    expect(protectedCount).toBe(2);
    expect(cancellationCount).toBe(2);
  });

  it("cancels a failed guest response without masking its HTTP error", async () => {
    let cancellationCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async () =>
      cancellableErrorResponse(
        500,
        () => {
          cancellationCount += 1;
        },
        new Error("provider body refused cancellation"),
      ),
    );
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    await expect(client.prepare()).rejects.toMatchObject({
      name: "TxlineHttpError",
      status: 500,
    });
    expect(cancellationCount).toBe(1);
  });

  it("cancels a terminal protected 5xx body without masking its HTTP error", async () => {
    let cancellationCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        return new Response(JSON.stringify({ token: "fixture-terminal-jwt" }), {
          status: 200,
        });
      }
      return cancellableErrorResponse(
        502,
        () => {
          cancellationCount += 1;
        },
        new Error("provider body refused cancellation"),
      );
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    await expect(client.get("/api/fixtures/snapshot")).rejects.toMatchObject({
      name: "TxlineHttpError",
      status: 502,
    });
    expect(cancellationCount).toBe(1);
  });
});
