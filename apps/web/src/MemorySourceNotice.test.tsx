import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemorySourceNotice } from "./MemorySourceNotice.js";

describe("verified Match Memory source notice", () => {
  it("labels archive-qualified Memory as verified server truth", () => {
    const markup = renderToStaticMarkup(
      createElement(MemorySourceNotice, { source: "archive-verified" }),
    );

    expect(markup).toContain("ARCHIVE VERIFIED");
    expect(markup).toContain("TxLINE-backed archive");
    expect(markup).not.toContain("device");
  });

  it("never turns an unavailable archive into a local Memory fallback", () => {
    const markup = renderToStaticMarkup(
      createElement(MemorySourceNotice, { source: "unavailable" }),
    );

    expect(markup).toContain("VERIFIED MEMORY UNAVAILABLE");
    expect(markup).not.toContain("OFFLINE DEVICE FALLBACK");
  });
});
