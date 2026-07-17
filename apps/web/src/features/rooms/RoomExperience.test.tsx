import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RoomExperience } from "./RoomExperience.js";
import {
  createInitialSenseDraft,
  isSenseDraftComplete,
  selectSenseOption,
  toSensePicks,
} from "./model.js";
import type { RoomApi, RoomView } from "./types.js";

const fixture = {
  awayTeam: {
    code: "FRA",
    name: "France",
    primary: "#173a70",
    secondary: "#d34d58",
  },
  homeTeam: {
    code: "ARG",
    name: "Argentina",
    primary: "#75aadb",
    secondary: "#f3efe4",
  },
  id: "fixture-1",
  isReplay: true,
  kickoffAt: "2026-07-19T19:00:00.000Z",
} as const;

const markets = [
  {
    id: "winner",
    label: "Who wins?",
    selections: [
      { id: "HOME", label: "Argentina", price: 2.7 },
      { id: "DRAW", label: "Draw", price: 2.7 },
      { id: "AWAY", label: "France", price: 2.7 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "goals_2_5",
    label: "Total goals · 2.5",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "cards_4_5",
    label: "Total cards · 4.5",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "corners_9_5",
    label: "Total corners · 9.5",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "btts",
    label: "Both teams to score?",
    selections: [
      { id: "YES", label: "Yes", price: 1.9 },
      { id: "NO", label: "No", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
] as const;

function room(phase: RoomView["sense"]["phase"]): RoomView {
  return {
    currentMoment: null,
    fixture,
    id: "room-1",
    inviteUrl: "https://matchsense.test/rooms/join/abcdefghijklmnopqrstuv",
    isHost: true,
    members: [
      {
        hasPicks: false,
        id: "fan-one",
        nickname: "Abhinav",
        role: "host",
        teamCode: "ARG",
      },
    ],
    name: "Final night",
    reactions: [],
    sense: {
      currencyLabel: "FRIEND SENSE · NO MONEY · NO PRIZES",
      leaderboard: [],
      markets,
      mySlate: null,
      phase,
      revealedSlates: [],
      total: 100,
    },
    viewerMemberId: "fan-one",
  };
}

const api: RoomApi = {
  createExperienceRoom: async () => ({
    fixtureId: fixture.id,
    inviteUrl: "",
    room: room("DRAFT"),
    runId: "run-one",
  }),
  createRoom: async () => ({ inviteUrl: "", room: room("DRAFT") }),
  getRoom: async () => room("OPEN"),
  joinRoom: async () => ({ lateJoin: false, room: room("OPEN") }),
  openPicks: async () => room("OPEN"),
  previewInvite: async () => ({
    callsLocked: false,
    expiresAt: fixture.kickoffAt,
    fixture,
    hostNickname: "Abhinav",
    memberNicknames: ["Abhinav"],
    roomName: "Final night",
  }),
  savePicks: async () => room("OPEN"),
  sendReaction: async () => ({ receiptId: "r1", room: room("LIVE") }),
  startExperience: async () => room("LIVE"),
  subscribeRoom: () => () => undefined,
};

describe("100-Sense room experience", () => {
  it("requires one selection in each market while keeping exactly 100 Sense", () => {
    let draft = createInitialSenseDraft();
    draft = selectSenseOption(draft, "winner", "HOME");
    draft = selectSenseOption(draft, "goals_2_5", "OVER");
    draft = selectSenseOption(draft, "cards_4_5", "UNDER");
    draft = selectSenseOption(draft, "corners_9_5", "OVER");
    draft = selectSenseOption(draft, "btts", "YES");
    expect(isSenseDraftComplete(draft)).toBe(true);
    expect(
      toSensePicks(draft).reduce((total, pick) => total + pick.allocation, 0),
    ).toBe(100);
  });

  it("renders the host open gate with the no-money contract", () => {
    const html = renderToStaticMarkup(
      createElement(RoomExperience, {
        api,
        route: { initialRoom: room("DRAFT"), mode: "room", roomId: "room-1" },
      }),
    );
    expect(html).toContain("Open 100-Sense picks");
    expect(html).toContain("FRIEND SENSE · NO MONEY · NO PRIZES");
    expect(html).toContain("Share private invite");
    expect(html.match(/ms-team-flag/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("renders all five MatchSense-priced markets when picks open", () => {
    const html = renderToStaticMarkup(
      createElement(RoomExperience, {
        api,
        route: { initialRoom: room("OPEN"), mode: "room", roomId: "room-1" },
      }),
    );
    expect(html).toContain("Who wins?");
    expect(html).toContain("Total goals · 2.5");
    expect(html).toContain("Total cards · 4.5");
    expect(html).toContain("Total corners · 9.5");
    expect(html).toContain("Both teams to score?");
    expect(html.match(/MatchSense pricing/g)?.length).toBe(5);
    expect(html).toContain("Start Experience");
  });

  it("does not expose Experience controls to a non-host", () => {
    const html = renderToStaticMarkup(
      createElement(RoomExperience, {
        api,
        route: {
          initialRoom: { ...room("OPEN"), isHost: false },
          mode: "room",
          roomId: "room-1",
        },
      }),
    );
    expect(html).not.toContain("Start Experience");
  });
});
