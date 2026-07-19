import { describe, expect, it, vi } from "vitest";

import { createExperienceRoomApi } from "./experience-room-api.js";

describe("Experience Room API", () => {
  it("uses the durable Experience Room contract for create, calls, lock and start", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ id: "room-one", room: { id: "room-one" } }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
    );
    const api = createExperienceRoomApi(fetcher);

    await api.create({
      addDemoSupporters: true,
      awayTeam: "FRA",
      homeTeam: "ARG",
      name: "Final night",
      nickname: "matchfan",
      teamCode: "ARG",
    });
    await api.saveCalls("room-one", [
      { answer: "HOME", confidence: 3, target: "result" },
      { answer: "YES", confidence: 2, target: "goals" },
      { answer: "YES", confidence: 1, target: "cards" },
    ]);
    await api.lock("room-one");
    await api.start("room-one");

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/experience/rooms",
      "/api/v1/experience/rooms/room-one/calls",
      "/api/v1/experience/rooms/room-one/calls/lock",
      "/api/v1/experience/rooms/room-one/start",
    ]);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "PUT",
      "POST",
      "POST",
    ]);
  });

  it("unwraps the server reaction result back into the authoritative room", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          reaction: { id: "reaction-1" },
          room: { id: "room-one" },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 201,
        },
      ),
    );

    const result = await createExperienceRoomApi(fetcher).react("room-one", {
      kind: "ROAR",
      momentId: "goal-one",
      recipientParticipantId: "friend-one",
      revision: 1,
    });

    expect(result.id).toBe("room-one");
  });
});
