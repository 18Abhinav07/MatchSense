import { describe, expect, it } from "vitest";

import { selectPendingActivation } from "./activation-store.js";

describe("pending activation selection", () => {
  it("uses the newest unexpired intent and never revives an old notification", () => {
    expect(
      selectPendingActivation(
        [
          {
            activation: { intentId: "expired" },
            createdAt: 10,
            expiresAt: 20,
            intentId: "expired",
          },
          {
            activation: { intentId: "older" },
            createdAt: 30,
            expiresAt: 130,
            intentId: "older",
          },
          {
            activation: { intentId: "latest" },
            createdAt: 40,
            expiresAt: 140,
            intentId: "latest",
          },
        ],
        100,
      ),
    ).toMatchObject({ intentId: "latest" });
  });
});
