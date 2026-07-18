import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListeningProvider } from "../../ListeningProvider.js";
import { ListeningControl } from "./ListeningControl.js";

describe("ListeningControl", () => {
  it("offers a truthful opt-in before any commentary can play", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ListeningProvider,
        null,
        createElement(ListeningControl, {
          moment: {
            familyId: "goal-1",
            fixtureId: "arg-fra",
            revision: 1,
            text: "Argentina score.",
          },
        }),
      ),
    );

    expect(markup).toContain("Start listening");
    expect(markup).toContain("Audio starts only after you tap");
  });
});
