import { describe, expect, it, vi } from "vitest";

import { startByRole } from "./entry.js";

const databaseUrl = "postgresql://db.example/matchsense";

describe("role-selected server entrypoint", () => {
  it("starts the API role without loading the collector", async () => {
    const apiRuntime = { close: vi.fn(async () => undefined) };
    const startApi = vi.fn(async () => apiRuntime);
    const loadApi = vi.fn(async () => ({ startApi }));
    const loadCollector = vi.fn(async () => ({
      startCollector: vi.fn(async () => ({ close: async () => undefined })),
    }));

    const started = await startByRole(
      { DATABASE_URL: databaseUrl, ROLE: "api" },
      { loadApi, loadCollector },
    );

    expect(started).toMatchObject({
      apiStarted: true,
      collectorStarted: false,
      role: "api",
    });
    expect(loadApi).toHaveBeenCalledOnce();
    expect(loadCollector).not.toHaveBeenCalled();
    expect(startApi).toHaveBeenCalledWith(
      expect.objectContaining({ role: "api" }),
    );
  });

  it("starts the collector role without loading the API", async () => {
    const collectorRuntime = { close: vi.fn(async () => undefined) };
    const startCollector = vi.fn(async () => collectorRuntime);
    const loadApi = vi.fn(async () => ({
      startApi: vi.fn(async () => ({ close: async () => undefined })),
    }));
    const loadCollector = vi.fn(async () => ({ startCollector }));

    const started = await startByRole(
      {
        DATABASE_URL: databaseUrl,
        ROLE: "worker",
        TXLINE_API_TOKEN: "fixture-collector-only-token",
      },
      { loadApi, loadCollector },
    );

    expect(started).toMatchObject({
      apiStarted: false,
      collectorStarted: true,
      role: "worker",
    });
    expect(loadApi).not.toHaveBeenCalled();
    expect(loadCollector).toHaveBeenCalledOnce();
    expect(startCollector).toHaveBeenCalledWith(
      expect.objectContaining({ role: "worker" }),
    );
  });
});
