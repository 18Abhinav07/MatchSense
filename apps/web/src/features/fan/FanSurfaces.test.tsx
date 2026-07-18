import { createElement } from "react";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AvatarStep,
  FanAvatar,
  HandleStep,
  ProfileCompletionOverlay,
  ProfileSurface,
} from "./FanSurfaces.js";

const argentina = {
  code: "ARG",
  name: "Argentina",
  primary: "#74acdf",
  secondary: "#f6f2e8",
};

const france = {
  code: "FRA",
  name: "France",
  primary: "#203c7c",
  secondary: "#f4f1e8",
};

const savedArgentinaFan = {
  avatarVariant: "arg-pulse",
  createdAt: "2026-07-18T00:00:00.000Z",
  deletedAt: null,
  favoriteTeam: "ARG",
  handle: "matchfan",
  handleNormalized: "matchfan",
  id: "fan-42",
  preferences: {},
  profile: {},
  updatedAt: "2026-07-18T00:00:00.000Z",
};

describe("fan identity surfaces", () => {
  it("uses a centered confirmation dialog instead of inline second-tap deletion", async () => {
    const source = await readFile(
      new URL("./FanSurfaces.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("Delete everything");
    expect(source).toContain("Cancel");
    expect(source).not.toContain("Tap again to delete everything");
  });

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

  it("does not create a fallback team while the real catalogue is unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(ProfileCompletionOverlay, {
        busy: false,
        catalog: { teams: [] },
        error: null,
        onComplete: () => undefined,
      }),
    );

    expect(markup).toContain("Team catalogue unavailable");
    expect(markup).not.toContain("Argentina");
  });

  it("requires an explicit real-team reselect when the saved team is absent from the catalogue", () => {
    const markup = renderToStaticMarkup(
      createElement(ProfileSurface, {
        api: {} as never,
        catalog: { teams: [france] },
        fan: savedArgentinaFan,
        onBack: () => undefined,
        onDeleted: () => undefined,
        onSaved: () => undefined,
      }),
    );

    expect(markup).toContain("Saved team unavailable");
    expect(markup).toContain("Choose a real team");
    expect(markup).not.toContain("Save profile");
  });
});
