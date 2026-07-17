import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemorySourceNotice } from "./MemorySourceNotice.js";

describe("Match Memory source notice", () => {
  it("labels a device cache only as an offline fallback", () => {
    const markup = renderToStaticMarkup(
      createElement(MemorySourceNotice, { source: "local-fallback" }),
    );

    expect(markup).toContain("OFFLINE DEVICE FALLBACK");
    expect(markup).toContain("server memory is unavailable");
    expect(markup).not.toContain("Synced to your fan profile");
  });

  it("describes authenticated server history as the source of truth", () => {
    const markup = renderToStaticMarkup(
      createElement(MemorySourceNotice, { source: "server" }),
    );

    expect(markup).toContain("Synced to your fan profile");
    expect(markup).not.toContain("OFFLINE DEVICE FALLBACK");
  });
});
