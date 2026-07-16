import { describe, expect, it } from "vitest";

import { parseServerEnv } from "./config.js";

describe("parseServerEnv", () => {
  it.each([
    "postgres://db.example/matchsense",
    "postgresql://db.example/matchsense",
  ])("accepts the %s database protocol", (databaseUrl) => {
    expect(parseServerEnv({ DATABASE_URL: databaseUrl }).databaseUrl).toBe(
      databaseUrl,
    );
  });

  it("requires a PostgreSQL URL and applies safe local defaults", () => {
    const config = parseServerEnv({
      DATABASE_URL: "postgresql://db.example/matchsense",
    });

    expect(config).toEqual({
      databaseUrl: "postgresql://db.example/matchsense",
      dataRightsMode: "synthetic_demo",
      host: "0.0.0.0",
      port: 8080,
    });
  });

  it.each([
    [{}, "missing database URL"],
    [{ DATABASE_URL: "not-a-url" }, "invalid database URL"],
    [{ DATABASE_URL: "https://db.example/matchsense" }, "non-PostgreSQL URL"],
    [
      { DATABASE_URL: "postgresql://localhost/matchsense", PORT: "0" },
      "port below range",
    ],
    [
      { DATABASE_URL: "postgresql://localhost/matchsense", PORT: "65536" },
      "port above range",
    ],
    [
      { DATABASE_URL: "postgresql://localhost/matchsense", PORT: "8.5" },
      "fractional port",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/matchsense",
        DATA_RIGHTS_MODE: "authorized_live",
      },
      "unavailable rights mode",
    ],
  ])("rejects %s", (environment, _label) => {
    expect(() => parseServerEnv(environment)).toThrow(
      "Invalid MatchSense server configuration",
    );
  });

  it("does not include rejected secret values in errors", () => {
    const rejectedValue = "database-password-must-not-be-logged";

    expect(() => parseServerEnv({ DATABASE_URL: rejectedValue })).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(rejectedValue),
      }),
    );
  });
});
