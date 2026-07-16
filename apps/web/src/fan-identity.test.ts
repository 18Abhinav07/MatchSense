import { describe, expect, it } from "vitest";

import { getOrCreateFanIdentity } from "./fan-identity.js";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("anonymous fan identity", () => {
  it("keeps one opaque device identity without requiring login", () => {
    const storage = new MemoryStorage();
    let calls = 0;
    const id = () => `device-${++calls}`;

    expect(getOrCreateFanIdentity(storage, id)).toBe("device-1");
    expect(getOrCreateFanIdentity(storage, id)).toBe("device-1");
    expect(calls).toBe(1);
  });

  it("replaces malformed persisted values", () => {
    const storage = new MemoryStorage();
    storage.setItem("matchsense.fanId", "<script>");

    expect(getOrCreateFanIdentity(storage, () => "device-safe_2")).toBe(
      "device-safe_2",
    );
  });
});
