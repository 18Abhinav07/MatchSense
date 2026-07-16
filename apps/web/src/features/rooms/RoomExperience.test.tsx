import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RoomExperience, type RoomExperienceProps } from "./RoomExperience.js";
import {
  answerCall,
  assignConfidence,
  createInitialCallDraft,
  isCallDraftComplete,
} from "./model.js";
import type {
  RoomApi,
  RoomFixture,
  RoomInvitePreview,
  RoomView,
} from "./types.js";

const fixture: RoomFixture = {
  awayTeam: {
    code: "BRA",
    name: "Brazil",
    primary: "#f6cf3a",
    secondary: "#16653d",
  },
  homeTeam: {
    code: "ARG",
    foreground: "#0b2035",
    name: "Argentina",
    primary: "#75aadb",
    secondary: "#f3efe4",
  },
  id: "arg-bra-final",
  isReplay: true,
  kickoffAt: "2026-07-19T16:00:00.000Z",
};

const preview: RoomInvitePreview = {
  callsLocked: false,
  expiresAt: "2026-07-19T17:00:00.000Z",
  fixture,
  hostNickname: "Pratik",
  memberNicknames: ["Pratik", "Yash"],
  roomName: "Finals Night",
};

function room(overrides: Partial<RoomView> = {}): RoomView {
  return {
    calls: {
      lockAt: fixture.kickoffAt,
      locked: false,
      pointsOnly: true,
      progress: { cards: 4, corners: 7, goals: 1 },
      targets: [
        {
          question: "3+ total goals?",
          reliability: "reliable",
          sourceLabel: "MatchSense game rule",
          stat: "goals",
          threshold: 3,
          version: 1,
        },
        {
          question: "5+ total cards?",
          reliability: "reliable",
          sourceLabel: "MatchSense game rule",
          stat: "cards",
          threshold: 5,
          version: 1,
        },
        {
          question: "10+ total corners?",
          reliability: "reliable",
          sourceLabel: "MatchSense game rule",
          stat: "corners",
          threshold: 10,
          version: 1,
        },
      ],
      viewerEntry: null,
    },
    currentMoment: {
      label: "Goal · Argentina",
      minute: "67′",
      momentId: "arg-bra-final:goal:67",
      revision: 7,
      score: { away: 0, home: 1 },
      state: "confirmed",
    },
    fixture,
    id: "room-finals-night",
    inviteUrl: "https://matchsense.app/join/finals-night-67",
    leaderboard: [
      {
        correctCalls: 1,
        final: false,
        memberId: "abhinav",
        nickname: "Abhinav",
        points: 300,
        rank: 1,
        submittedAt: "2026-07-19T15:40:00.000Z",
      },
      {
        correctCalls: 1,
        final: false,
        memberId: "pratik",
        nickname: "Pratik",
        points: 100,
        rank: 2,
        submittedAt: "2026-07-19T15:41:00.000Z",
      },
    ],
    members: [
      {
        callsLocked: true,
        id: "abhinav",
        muted: false,
        nickname: "Abhinav",
        role: "host",
        teamCode: "ARG",
      },
      {
        callsLocked: true,
        id: "pratik",
        muted: false,
        nickname: "Pratik",
        role: "member",
        teamCode: "BRA",
      },
    ],
    name: "Finals Night",
    phase: "live",
    reactions: [],
    viewerMemberId: "abhinav",
    ...overrides,
  };
}

const api: RoomApi = {
  createRoom: async () => ({ room: room(), inviteUrl: room().inviteUrl ?? "" }),
  getRoom: async () => room(),
  joinRoom: async () => ({ room: room(), lateJoin: false }),
  previewInvite: async () => preview,
  playReplay: async () => room({ phase: "final" }),
  saveCalls: async () => room(),
  sendReaction: async () => ({ room: room(), receiptId: "reaction-1" }),
  subscribeRoom: () => () => undefined,
};

function render(props: RoomExperienceProps) {
  return renderToStaticMarkup(
    createElement(
      RoomExperience as FunctionComponent<RoomExperienceProps>,
      props,
    ),
  );
}

describe("Call Three draft", () => {
  it("keeps confidence 1, 2, and 3 unique by swapping the displaced value", () => {
    const initial = createInitialCallDraft();
    const changed = assignConfidence(initial, "goals", 1);

    expect(changed.goals.confidence).toBe(1);
    expect(changed.cards.confidence).toBe(3);
    expect(changed.corners.confidence).toBe(2);
    expect(
      new Set(Object.values(changed).map(({ confidence }) => confidence)),
    ).toEqual(new Set([1, 2, 3]));
  });

  it("becomes lockable only after all three YES or NO calls are made", () => {
    let draft = createInitialCallDraft();
    expect(isCallDraftComplete(draft)).toBe(false);

    draft = answerCall(draft, "goals", "yes");
    draft = answerCall(draft, "cards", "no");
    draft = answerCall(draft, "corners", "yes");

    expect(isCallDraftComplete(draft)).toBe(true);
  });
});

describe("RoomExperience", () => {
  it("opens with a private, points-only room creation ritual", () => {
    const markup = render({ api, route: { fixture, mode: "create" } });

    expect(markup).toContain("Create the match ritual.");
    expect(markup).toContain("Room name");
    expect(markup).toContain("Your nickname");
    expect(markup).toContain("Friend points only");
    expect(markup).toContain("No money. No prizes.");
  });

  it("keeps an optional exit control available throughout routed room screens", () => {
    const markup = render({
      api,
      onExit: () => undefined,
      route: { fixture, mode: "create" },
    });

    expect(markup).toContain('aria-label="Close room"');
  });

  it("makes the host, room, match, and nickname step explicit on an invite", () => {
    const markup = render({
      api,
      route: { inviteCode: "finals-night-67", mode: "invite", preview },
    });

    expect(markup).toContain("Pratik invited you");
    expect(markup).toContain("Finals Night");
    expect(markup).toContain("Argentina");
    expect(markup).toContain("Brazil");
    expect(markup).toContain("Join and make calls");
  });

  it("shows late joiners the live room without pretending calls are still open", () => {
    const spectatorRoom = room({
      members: [
        ...room().members,
        {
          callsLocked: false,
          id: "yash",
          muted: false,
          nickname: "Yash",
          role: "spectator",
          teamCode: null,
        },
      ],
      viewerMemberId: "yash",
    });
    const markup = render({
      api,
      route: {
        initialRoom: spectatorRoom,
        mode: "room",
        roomId: spectatorRoom.id,
      },
    });

    expect(markup).toContain("You joined after kickoff.");
    expect(markup).toContain("Watch the room live");
    expect(markup).not.toContain("Lock my calls");
  });

  it("keeps provisional rankings and controlled reactions beside the current Moment", () => {
    const liveRoom = room();
    const markup = render({
      api,
      route: { initialRoom: liveRoom, mode: "room", roomId: liveRoom.id },
    });

    expect(markup).toContain("Room ranking · provisional");
    expect(markup).toContain("Goal · Argentina");
    expect(markup).toContain("ROAR");
    expect(markup).toContain("COLD");
    expect(markup).toContain("CALLED IT");
    expect(markup).toContain("Reactions reference revision 7");
  });

  it("gives only a replay-room host the polished match conductor", () => {
    const hostMarkup = render({
      api,
      route: {
        initialRoom: room({ phase: "lobby" }),
        mode: "room",
        roomId: room().id,
      },
    });
    const memberMarkup = render({
      api,
      route: {
        initialRoom: room({ phase: "lobby", viewerMemberId: "pratik" }),
        mode: "room",
        roomId: room().id,
      },
    });
    const liveFixtureMarkup = render({
      api,
      route: {
        initialRoom: room({
          fixture: { ...fixture, isReplay: false },
          phase: "lobby",
        }),
        mode: "room",
        roomId: room().id,
      },
    });

    expect(hostMarkup).toContain("Play match replay");
    expect(hostMarkup).toContain("Replay room · host control");
    expect(hostMarkup).toContain(
      "Everyone in the room follows the same Moment",
    );
    expect(memberMarkup).not.toContain("Play match replay");
    expect(liveFixtureMarkup).not.toContain("Play match replay");
  });

  it("closes on a final room result without prize or money semantics", () => {
    const finalRoom = room({
      leaderboard: room().leaderboard.map((entry) => ({
        ...entry,
        final: true,
      })),
      phase: "final",
    });
    const markup = render({
      api,
      route: { initialRoom: finalRoom, mode: "room", roomId: finalRoom.id },
    });

    expect(markup).toContain("Final room result");
    expect(markup).toContain("Friend points · final");
    expect(markup).toContain("No money. No prizes.");
    expect(markup).not.toContain("payout");
    expect(markup).not.toContain("stake");
    expect(markup).not.toContain("odds");
  });
});
