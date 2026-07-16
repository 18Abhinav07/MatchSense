const STORAGE_KEY = "matchsense.fanId";
const FAN_ID = /^[A-Za-z0-9_-]{6,120}$/u;

type IdentityStorage = Pick<Storage, "getItem" | "setItem">;

export function getOrCreateFanIdentity(
  storage: IdentityStorage,
  createId: () => string = () => crypto.randomUUID(),
) {
  const existing = storage.getItem(STORAGE_KEY);
  if (existing && FAN_ID.test(existing)) return existing;

  const created = createId();
  if (!FAN_ID.test(created)) {
    throw new Error("Could not create a safe fan identity");
  }
  storage.setItem(STORAGE_KEY, created);
  return created;
}
