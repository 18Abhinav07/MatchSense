import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AvatarStep,
  FanAvatar,
  HandleStep,
  ProfileCompletionOverlay,
} from "./FanSurfaces.js";

const argentina = {
  code: "ARG",
  name: "Argentina",
  primary: "#74acdf",
  secondary: "#f6f2e8",
};

describe("fan identity surfaces", () => {
  it("asks for a public handle without exposing the immutable fan id", () => {
    const markup = renderToStaticMarkup(
      createElement(HandleStep, {
        busy: false,
        error: null,
        onContinue: () => undefined,
        team: argentina,
      }),
    );

    expect(markup).toContain("Choose your MatchSense handle");
    expect(markup).toContain('autoComplete="username"');
    expect(markup).toContain("Check handle");
    expect(markup).not.toContain("fan-1");
  });

  it("offers authored team-themed avatar variants without uploads", () => {
    const markup = renderToStaticMarkup(
      createElement(AvatarStep, {
        busy: false,
        error: null,
        handle: "Abhinav_07",
        onChoose: () => undefined,
        team: argentina,
      }),
    );

    expect(markup).toContain("Pick your supporter mark");
    expect(markup).toContain("arg-pulse");
    expect(markup).toContain("arg-terrace");
    expect(markup).toContain("arg-wave");
    expect(markup).not.toContain('type="file"');
  });

  it("renders a team avatar as an authored local identity", () => {
    const markup = renderToStaticMarkup(
      createElement(FanAvatar, {
        handle: "Abhinav_07",
        team: argentina,
        variant: "arg-wave",
      }),
    );

    expect(markup).toContain("A0");
    expect(markup).toContain('data-variant="wave"');
  });

  it("keeps a deep-linked destination mounted behind minimal completion", () => {
    const markup = renderToStaticMarkup(
      createElement(ProfileCompletionOverlay, {
        busy: false,
        catalog: { teams: [argentina] },
        error: null,
        onComplete: () => undefined,
      }),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Finish your fan card");
    expect(markup).toContain("Your destination is ready behind this card");
  });
});
