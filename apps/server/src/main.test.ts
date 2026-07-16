import { describe, expect, it } from "vitest";

describe("server entrypoint", () => {
  it("is safe to import without parsing environment or opening a listener", async () => {
    const entrypoint = await import("./main.js");

    expect(entrypoint.startServer).toBeTypeOf("function");
  });
});
