import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { FanRepository, FanSessionRecord } from "@matchsense/db";

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

export interface FanSessionServiceOptions {
  id?: (() => string) | undefined;
  now?: (() => Date) | undefined;
  randomBytes?: ((size: number) => Buffer) | undefined;
  repository: Pick<FanRepository, "createGuest" | "resolveSession">;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createFanSessionService(options: FanSessionServiceOptions) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const token = () => randomBytes(32).toString("base64url");

  return {
    createGuest: async () => {
      const createdAt = now();
      const sessionToken = token();
      const csrfToken = token();
      const expiresAt = new Date(
        createdAt.getTime() + SESSION_LIFETIME_MS,
      ).toISOString();
      const fan = await options.repository.createGuest({
        csrfHash: sha256(csrfToken),
        expiresAt,
        fanId: id(),
        sessionHash: sha256(sessionToken),
      });
      return { csrfToken, expiresAt, fan, sessionToken };
    },
    hash: sha256,
    resolve: (sessionToken: string) =>
      options.repository.resolveSession({ sessionHash: sha256(sessionToken) }),
    verifyCsrf: (session: FanSessionRecord, csrfToken: string) => {
      const actual = Buffer.from(sha256(csrfToken), "hex");
      const expected = Buffer.from(session.csrfHash, "hex");
      return (
        actual.byteLength === expected.byteLength &&
        timingSafeEqual(actual, expected)
      );
    },
  };
}

export type FanSessionService = ReturnType<typeof createFanSessionService>;
