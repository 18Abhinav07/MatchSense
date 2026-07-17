import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from "node:crypto";

import {
  parsePushSubscription,
  type SerializedPushSubscription,
} from "./push-subscriptions.js";

const AAD = Buffer.from("matchsense:push-subscription:v1", "utf8");

export interface EncryptedPushSubscription {
  authTag: Uint8Array;
  ciphertext: Uint8Array;
  endpointHash: string;
  iv: Uint8Array;
  keyVersion: number;
}

export function createPushSubscriptionCipher(options: {
  keyVersion?: number;
  randomBytes?: (size: number) => Buffer;
  secret: string;
}) {
  if (options.secret.length < 16) {
    throw new Error("Push subscription encryption secret is too short");
  }
  const keyVersion = options.keyVersion ?? 1;
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error("Push subscription key version is invalid");
  }
  const key = createHash("sha256").update(options.secret).digest();
  const randomBytes = options.randomBytes ?? nodeRandomBytes;

  return {
    open: (sealed: EncryptedPushSubscription): SerializedPushSubscription => {
      if (sealed.keyVersion !== keyVersion) {
        throw new Error("Push subscription encryption key is unavailable");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(sealed.iv),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(sealed.authTag));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext)),
        decipher.final(),
      ]);
      return parsePushSubscription(JSON.parse(plaintext.toString("utf8")));
    },
    seal: (input: unknown): EncryptedPushSubscription => {
      const subscription = parsePushSubscription(input);
      const iv = randomBytes(12);
      if (iv.byteLength !== 12) {
        throw new Error("Push subscription encryption IV is invalid");
      }
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(subscription), "utf8"),
        cipher.final(),
      ]);
      return {
        authTag: cipher.getAuthTag(),
        ciphertext,
        endpointHash: createHash("sha256")
          .update(subscription.endpoint)
          .digest("hex"),
        iv,
        keyVersion,
      };
    },
  };
}

export type PushSubscriptionCipher = ReturnType<
  typeof createPushSubscriptionCipher
>;
