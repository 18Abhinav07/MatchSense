import { describe, expect, it, vi } from "vitest";

import { createListeningApi } from "./listening-api.js";

describe("Pocket Listening browser API", () => {
  it("creates and removes a same-origin fixture listening session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fixtureId: "experience:run-1",
            id: "listen-1",
            perspectiveTeam: "ARG",
          }),
          { headers: { "content-type": "application/json" }, status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createListeningApi(fetcher);

    await expect(
      api.create({
        fixtureId: "experience:run-1",
        perspectiveTeam: "ARG",
      }),
    ).resolves.toMatchObject({ id: "listen-1" });
    await api.remove("listen-1");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/v1/fixtures/experience%3Arun-1/listening-sessions",
      expect.objectContaining({
        body: JSON.stringify({ perspectiveTeam: "ARG" }),
        method: "POST",
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/v1/listening-sessions/listen-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(api.streamUrl("listen-1")).toBe(
      "/api/v1/listening-sessions/listen-1/stream.mp3",
    );
  });
});
