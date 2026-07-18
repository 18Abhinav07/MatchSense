import { describe, expect, it } from "vitest";

import * as rooms from "./index.js";

describe("Call Three Room public module", () => {
  it("exports the durable Room surface without allocation helpers", () => {
    expect(rooms.createCallThreeRoomApi).toBeTypeOf("function");
    expect(rooms).not.toHaveProperty("createInitialSenseDraft");
  });
});
