import { describe, expect, it, vi } from "vitest";

import type { MatchMemoryRecord } from "./memory-api.js";
import type { MatchMemoryView } from "./memory-view.js";
import { loadMemoryHistory, loadOneMemory } from "./memory-loader.js";

const remote = { fixtureId: "remote" } as MatchMemoryRecord;
const local = { snapshot: { fixtureId: "local" } } as MatchMemoryView;

describe("server-first Match Memory loading", () => {
  it("never reads device history when authenticated server history succeeds", async () => {
    const readLocal = vi.fn(() => [local]);

    await expect(
      loadMemoryHistory({
        fetchRemote: async () => [remote],
        readLocal,
        toView: () => ({
          ...local,
          snapshot: { ...local.snapshot, fixtureId: "remote" },
        }),
      }),
    ).resolves.toMatchObject({
      entries: [{ snapshot: { fixtureId: "remote" } }],
      source: "server",
    });
    expect(readLocal).not.toHaveBeenCalled();
  });

  it("uses a clearly typed device fallback only when the server fails", async () => {
    await expect(
      loadMemoryHistory({
        fetchRemote: async () => {
          throw new Error("offline");
        },
        readLocal: () => [local],
        toView: vi.fn(),
      }),
    ).resolves.toEqual({ entries: [local], source: "local-fallback" });

    await expect(
      loadOneMemory({
        fetchRemote: async () => {
          throw new Error("offline");
        },
        fixtureId: "local",
        readLocal: () => local,
        toView: vi.fn(),
      }),
    ).resolves.toEqual({ view: local, source: "local-fallback" });
  });
});
