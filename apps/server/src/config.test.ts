import { describe, expect, it } from "vitest";

import { parseServerEnv } from "./config.js";

describe("parseServerEnv", () => {
  it.each([
    "postgres://db.example/matchsense",
    "postgresql://db.example/matchsense",
  ])("accepts the %s database protocol", (databaseUrl) => {
    expect(
      parseServerEnv({
        DATABASE_URL: databaseUrl,
        DATA_RIGHTS_MODE: "synthetic_demo",
      }).databaseUrl,
    ).toBe(databaseUrl);
  });

  it("defaults the product to live TxLINE and never silently substitutes demo", () => {
    expect(() =>
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
      }),
    ).toThrow("Invalid MatchSense server configuration");
    const config = parseServerEnv({
      DATABASE_URL: "postgresql://db.example/matchsense",
      TXLINE_API_TOKEN: "fixture-server-only-token",
    });

    expect(config).toEqual({
      databaseUrl: "postgresql://db.example/matchsense",
      dataRightsMode: "txline_hackathon",
      host: "0.0.0.0",
      port: 8080,
      role: "worker",
      txlineApiToken: "fixture-server-only-token",
    });
  });

  it("enables the explicit hackathon TxLINE source only with its backend token", () => {
    expect(
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        DATA_RIGHTS_MODE: "txline_hackathon",
        TXLINE_API_TOKEN: "fixture-server-only-token",
      }),
    ).toMatchObject({
      dataRightsMode: "txline_hackathon",
      txlineApiToken: "fixture-server-only-token",
    });
    expect(() =>
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        DATA_RIGHTS_MODE: "txline_hackathon",
      }),
    ).toThrow("Invalid MatchSense server configuration");
  });

  it("separates push subscription encryption from VAPID signing keys", () => {
    const config = parseServerEnv({
      DATABASE_URL: "postgresql://db.example/matchsense",
      DATA_RIGHTS_MODE: "synthetic_demo",
      PUSH_SUBSCRIPTION_ENCRYPTION_SECRET:
        "fixture-subscription-encryption-secret",
      VAPID_PRIVATE_KEY: "fixture-private-key",
      VAPID_PUBLIC_KEY: "public-key",
      VAPID_SUBJECT: "mailto:team@matchsense.app",
    });

    expect(config.vapid).toEqual({
      privateKey: "fixture-private-key",
      publicKey: "public-key",
      subject: "mailto:team@matchsense.app",
    });
    expect(config.pushSubscriptionEncryptionSecret).toBe(
      "fixture-subscription-encryption-secret",
    );
    expect(() =>
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        DATA_RIGHTS_MODE: "synthetic_demo",
        VAPID_PUBLIC_KEY: "public-key-only",
      }),
    ).toThrow("Invalid MatchSense server configuration");
  });

  it("prevents TxLINE credentials and VAPID signing material from entering API processes", () => {
    expect(() =>
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        ROLE: "api",
        TXLINE_API_TOKEN: "fixture-must-never-be-on-the-api-service",
      }),
    ).toThrow("API role must not receive TxLINE token");
    expect(() =>
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        ROLE: "api",
        VAPID_PRIVATE_KEY: "fixture-must-never-be-on-the-api-service",
      }),
    ).toThrow("API role must not receive VAPID private key");
  });

  it("requires the TxLINE token only for the collector worker", () => {
    expect(() =>
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        ROLE: "worker",
      }),
    ).toThrow("TxLINE token is required");

    const apiConfig = parseServerEnv({
      DATABASE_URL: "postgresql://db.example/matchsense",
      ROLE: "api",
      PUSH_SUBSCRIPTION_ENCRYPTION_SECRET:
        "fixture-subscription-encryption-secret",
      VAPID_PUBLIC_KEY: "public-key",
    });
    expect(apiConfig).toMatchObject({ role: "api" });
    expect(apiConfig).not.toHaveProperty("txlineApiToken");
    expect(apiConfig).not.toHaveProperty("vapid");
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
