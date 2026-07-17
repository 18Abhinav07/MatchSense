import { describe, expect, it } from "vitest";

import { createPushSubscriptionCipher } from "./push-crypto.js";

const subscription = {
  endpoint: "https://push.example.test/device-secret",
  expirationTime: null,
  keys: {
    auth: "AQIDBAUGBwgJCgsMDQ4PEA",
    p256dh:
      "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
  },
};

describe("durable push subscription encryption", () => {
  it("round-trips valid material without persisting the endpoint in plaintext", () => {
    const cipher = createPushSubscriptionCipher({
      randomBytes: () => Buffer.alloc(12, 7),
      secret: "fixture-matchsense-secret-with-enough-entropy",
    });

    const sealed = cipher.seal(subscription);

    expect(sealed.endpointHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain(
      subscription.endpoint,
    );
    expect(cipher.open(sealed)).toEqual(subscription);
  });

  it("rejects tampered encrypted material", () => {
    const cipher = createPushSubscriptionCipher({
      randomBytes: () => Buffer.alloc(12, 9),
      secret: "fixture-matchsense-secret-with-enough-entropy",
    });
    const sealed = cipher.seal(subscription);
    const ciphertext = Uint8Array.from(sealed.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;

    expect(() => cipher.open({ ...sealed, ciphertext })).toThrow();
  });
});
