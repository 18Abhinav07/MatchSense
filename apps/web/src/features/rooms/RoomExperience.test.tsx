import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import * as roomExperienceModule from "./RoomExperience.js";
import type { CallThreeRoomApi, CallThreeRoomView } from "./types.js";

const { RoomExperience } = roomExperienceModule;

const fixture = {
  awayTeam: "FRA",
  fixtureId: "fixture-1",
  homeTeam: "ARG",
  kickoffAt: "2026-07-19T19:00:00.000Z",
  minute: "—",
  phase: "scheduled",
  provenance: "live_txline" as const,
  revision: 1,
  score: { away: 0, home: 0 },
  sourceLabel: "TXLINE MATCH DATA",
  updatedAt: "2026-07-18T19:00:00.000Z",
};

function room(
  status: CallThreeRoomView["status"],
  options: Partial<CallThreeRoomView> = {},
): CallThreeRoomView {
  return {
    createdAt: 1,
    currentMoment: null,
    finalisedAt: null,
    fixture,
    hostParticipantId: "fan-one",
    id: "room-one",
    kickoffAt: Date.parse(fixture.kickoffAt),
    leaderboard: [
      {
        correctCalls: 0,
        lockedAt: Date.parse(fixture.kickoffAt),
        nickname: "Abhinav",
        participantId: "fan-one",
        provisional: status !== "FINAL",
        rank: 1,
        score: 0,
        voidCalls: 0,
      },
    ],
    members: [
      {
        hasCalls: false,
        id: "fan-one",
        isHost: true,
        joinedAt: 1,
        lockedAt: null,
        nickname: "Abhinav",
        role: "PLAYER",
        teamCode: "ARG",
      },
      {
        hasCalls: true,
        id: "fan-two",
        isHost: false,
        joinedAt: 2,
        lockedAt: Date.parse(fixture.kickoffAt),
        nickname: "Maya",
        role: "PLAYER",
        teamCode: "FRA",
      },
    ],
    moments: [],
    myCalls: null,
    name: "Final night",
    points: {
      label: "MATCHSENSE POINTS · NON-TRANSFERABLE",
      lifetimeTotal: 300,
      roomPoints: 0,
    },
    reactions: [],
    revision: 1,
    status,
    targets: { cards: null, goals: null, result: null },
    viewerParticipantId: "fan-one",
    ...options,
  };
}

const api: CallThreeRoomApi = {
  create: async () => ({
    inviteCode: "abcdefghijklmnopqrstuv",
    invitePath: "/rooms/join/abcdefghijklmnopqrstuv",
    room: room("PRE_KICKOFF"),
  }),
  get: async () => room("PRE_KICKOFF"),
  join: async () => room("PRE_KICKOFF"),
  list: async () => [],
  lockCalls: async () => room("PRE_KICKOFF"),
  preview: async () => ({
    callsLocked: false,
    expiresAt: Date.parse(fixture.kickoffAt),
    fixture,
    hostNickname: "Abhinav",
    kickoffAt: Date.parse(fixture.kickoffAt),
    memberCount: 1,
    memberNicknames: ["Abhinav"],
    name: "Final night",
    roomId: "room-one",
    status: "PRE_KICKOFF",
  }),
  react: async () => ({
    reaction: room("LIVE").reactions[0]!,
    room: room("LIVE"),
  }),
  setCalls: async () => room("PRE_KICKOFF"),
  subscribe: () => () => undefined,
};

function render(initialRoom: CallThreeRoomView) {
  return renderToStaticMarkup(
    createElement(RoomExperience, {
      api,
      defaultNickname: "Abhinav",
      favoriteTeam: "ARG",
      route: { initialRoom, mode: "room", roomId: initialRoom.id },
      teams: [],
    }),
  );
}

describe("Call Three Room experience", () => {
  it("renders exactly three pre-kickoff calls with a non-transferable lifetime total", () => {
    const html = render(room("PRE_KICKOFF"));

    expect(html).toContain("Call Three");
    expect(html).toContain("Regulation result");
    expect(html).toContain("3+ total goals");
    expect(html).toContain("5+ total cards");
    expect(html).toContain("MATCHSENSE POINTS · NON-TRANSFERABLE");
    expect(html).toContain("300");
    expect(html).not.toContain("100 free");
    expect(html).not.toContain("MatchSense pricing");
  });

  it("renders a live provisional table and reactions only for a confirmed Moment", () => {
    const html = render(
      room("LIVE", {
        currentMoment: { momentId: "goal-one", revision: 2, varState: "CLEAR" },
      }),
    );

    expect(html).toContain("LIVE · PROVISIONAL");
    expect(html).toContain("ROAR");
    expect(html).toContain("COLD");
    expect(html).toContain("CALLED IT");
    expect(html).toContain("Calls locked at official kickoff");
  });

  it("makes a missing verified statistic visibly void at the final", () => {
    const html = render(
      room("FINAL", {
        finalisedAt: 2,
        targets: {
          cards: {
            answer: null,
            observedAt: 2,
            reason: "cards unavailable from verified final facts",
            state: "VOID",
            version: 3,
          },
          goals: {
            answer: "YES",
            observedAt: 2,
            reason: null,
            state: "RESOLVED",
            version: 3,
          },
          result: {
            answer: "HOME",
            observedAt: 2,
            reason: null,
            state: "RESOLVED",
            version: 3,
          },
        },
      }),
    );

    expect(html).toContain("VERIFIED FINAL");
    expect(html).toContain("VOID");
    expect(html).toContain("cards unavailable from verified final facts");
  });

  it("does not offer a Room for recorded or final fixtures", () => {
    const html = renderToStaticMarkup(
      createElement(RoomExperience, {
        api,
        defaultNickname: "Abhinav",
        favoriteTeam: "ARG",
        route: {
          fixture: {
            ...fixture,
            lifecycle: "FINAL",
            mode: "recorded",
            provenance: "recorded_txline_authorised",
          },
          mode: "create",
        },
        teams: [],
      }),
    );

    expect(html).toContain("Call Three unavailable");
    expect(html).not.toContain("Create Call Three Room");
  });

  it("allows the durable schedule row to start Room creation when it has no projection phase yet", () => {
    const html = renderToStaticMarkup(
      createElement(RoomExperience, {
        api,
        defaultNickname: "Abhinav",
        favoriteTeam: "ARG",
        route: {
          fixture: {
            awayTeam: "FRA",
            fixtureId: "fixture-1",
            homeTeam: "ARG",
            kickoffAt: "2099-07-19T19:00:00.000Z",
            lifecycle: "SCHEDULED",
            mode: "live",
            provenance: "live_txline",
          },
          mode: "create",
        },
        teams: [],
      }),
    );

    expect(html).toContain("Create Call Three Room");
  });

  it("retains the created invite with room name and match context", () => {
    const html = renderToStaticMarkup(
      createElement(RoomExperience, {
        api,
        defaultNickname: "Abhinav",
        favoriteTeam: "ARG",
        route: {
          fixture: {
            awayTeam: "FRA",
            fixtureId: "fixture-1",
            homeTeam: "ARG",
            kickoffAt: "2099-07-19T19:00:00.000Z",
            lifecycle: "SCHEDULED",
            mode: "live",
            provenance: "live_txline",
          },
          initialCreated: {
            inviteCode: "abcdefghijklmnopqrstuv",
            invitePath: "/rooms/join/abcdefghijklmnopqrstuv",
            room: room("PRE_KICKOFF"),
          },
          mode: "create",
        },
        teams: [
          {
            code: "ARG",
            name: "Argentina",
            primary: "#75aadb",
            secondary: "#f4f1e8",
          },
          {
            code: "FRA",
            name: "France",
            primary: "#203c7c",
            secondary: "#f4f1e8",
          },
        ],
      }),
    );

    expect(html).toContain("Final night");
    expect(html).toContain("Argentina");
    expect(html).toContain("France");
    expect(html).toContain("abcdefghijklmnopqrstuv");
    expect(html).toContain("/rooms/join/abcdefghijklmnopqrstuv");
    expect(html).toContain("Copy invite");
    expect(html).toContain("Share invite");
    expect(html).toContain("Open Room");
  });

  it("copies an absolute invite and uses native share with clipboard fallback", async () => {
    const copyInvite = (roomExperienceModule as Record<string, unknown>)
      .copyCallThreeInvite;
    const shareInvite = (roomExperienceModule as Record<string, unknown>)
      .shareCallThreeInvite;
    expect(copyInvite).toBeTypeOf("function");
    expect(shareInvite).toBeTypeOf("function");
    if (typeof copyInvite !== "function" || typeof shareInvite !== "function") {
      return;
    }

    const writeText = vi.fn(async () => undefined);
    const share = vi.fn(async () => undefined);
    const invite = {
      invitePath: "/rooms/join/abcdefghijklmnopqrstuv",
      roomName: "Final night",
    };

    await copyInvite(invite, {
      origin: "https://matchsense.example",
      writeText,
    });
    await shareInvite(invite, {
      origin: "https://matchsense.example",
      share,
      writeText,
    });
    await shareInvite(invite, {
      origin: "https://matchsense.example",
      writeText,
    });

    expect(writeText).toHaveBeenNthCalledWith(
      1,
      "https://matchsense.example/rooms/join/abcdefghijklmnopqrstuv",
    );
    expect(share).toHaveBeenCalledWith({
      text: "Join my private Call Three Room before kickoff.",
      title: "Final night · MatchSense",
      url: "https://matchsense.example/rooms/join/abcdefghijklmnopqrstuv",
    });
    expect(writeText).toHaveBeenNthCalledWith(
      2,
      "https://matchsense.example/rooms/join/abcdefghijklmnopqrstuv",
    );
  });
});
