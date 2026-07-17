import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConfirmedGoalMoment,
  FreshnessBanner,
  MatchMemory,
  ReconnectCatchUp,
  VarOverturnedMoment,
  VarStandsMoment,
  VarUnderReviewMoment,
} from "./HonestMoments.js";
import type {
  ConfirmedGoalMomentProps,
  MatchMemoryProps,
  MomentScore,
  MomentTeam,
  MomentTruth,
  ReconnectCatchUpProps,
  VarDecisionMomentProps,
  VarOverturnedMomentProps,
  VarReviewMomentProps,
} from "./types.js";

const argentina: MomentTeam = {
  code: "ARG",
  foreground: "#0b2035",
  name: "Argentina",
  primary: "#75aadb",
  secondary: "#f3efe4",
};

const france: MomentTeam = {
  code: "FRA",
  name: "France",
  primary: "#173a70",
  secondary: "#d34d58",
};

const score: MomentScore = {
  away: 0,
  awayTeam: france,
  home: 1,
  homeTeam: argentina,
};

const truth: MomentTruth = {
  eventId: "arg-fra-final:goal:23:revision-2",
  minute: "23′",
  revision: 2,
  sourceLabel: "TXLINE · DEVNET SOURCE",
};

function render<Props extends object>(
  component: FunctionComponent<Props>,
  props: Props,
) {
  return renderToStaticMarkup(createElement(component, props));
}

describe("honest Moment surfaces", () => {
  it("paints canonical goal truth before any celebration content", () => {
    const markup = render(
      ConfirmedGoalMoment as FunctionComponent<ConfirmedGoalMomentProps>,
      {
        assistName: "Ángel Di María",
        commentary: "Argentina break the silence. The lead is theirs.",
        consequence: "Argentina move to the top of the group.",
        onClose: () => undefined,
        playerName: "Lionel Messi",
        relation: "for",
        score,
        scoringTeam: argentina,
        sponsor: "PlayStation",
        truth,
      },
    );

    expect(markup).toContain('data-state="confirmed-goal"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-labelledby="');
    expect(markup).toContain("Goal · confirmed");
    expect(markup).toContain("Lionel Messi changes the match.");
    expect(markup).toContain("Moment presented by PlayStation");
    expect(markup).toContain("ms-team-flag");
    expect(markup.indexOf("Goal · confirmed")).toBeLessThan(
      markup.indexOf("GOAL"),
    );
  });

  it("holds celebration, sponsorship, and reactions throughout VAR review", () => {
    const markup = render(
      VarUnderReviewMoment as FunctionComponent<VarReviewMomentProps>,
      {
        attackingTeam: argentina,
        score,
        truth: { ...truth, revision: 3 },
      },
    );

    expect(markup).toContain('data-state="var-under-review"');
    expect(markup).toContain("Hold the roar.");
    expect(markup).toContain("Celebration held");
    expect(markup).toContain("Sponsor held");
    expect(markup).toContain("Reactions held");
    expect(markup).not.toContain("presented by");
  });

  it("renders distinct stands and overturned resolutions", () => {
    const standsMarkup = render(
      VarStandsMoment as FunctionComponent<VarDecisionMomentProps>,
      {
        onContinue: () => undefined,
        score,
        team: argentina,
        truth: { ...truth, revision: 4 },
      },
    );
    const overturnedMarkup = render(
      VarOverturnedMoment as FunctionComponent<VarOverturnedMomentProps>,
      {
        onContinue: () => undefined,
        reason: "Attacking handball",
        score: { ...score, home: 0 },
        supersededScore: { away: 0, home: 1 },
        team: argentina,
        truth: { ...truth, revision: 5 },
      },
    );

    expect(standsMarkup).toContain('data-state="var-stands"');
    expect(standsMarkup).toContain("The goal stands.");
    expect(standsMarkup).toContain("Continue celebration");
    expect(overturnedMarkup).toContain('data-state="var-overturned"');
    expect(overturnedMarkup).toContain("The goal is overturned.");
    expect(overturnedMarkup).toContain("Superseded");
    expect(overturnedMarkup).toContain("Attacking handball");
  });

  it("replays missed events in sequence order, not arrival-array order", () => {
    const markup = render(
      ReconnectCatchUp as FunctionComponent<ReconnectCatchUpProps>,
      {
        caughtUpAt: "20:44:18",
        events: [
          {
            id: "yellow-2",
            kind: "yellow_card",
            minute: "29′",
            revision: 9,
            sequence: 2,
            title: "Yellow card · France",
          },
          {
            id: "goal-1",
            kind: "goal",
            minute: "23′",
            revision: 8,
            sequence: 1,
            team: argentina,
            title: "Messi gives Argentina the lead",
          },
        ],
        onContinue: () => undefined,
        sourceLabel: "TXLINE · DEVNET SOURCE",
      },
    );

    expect(markup).toContain("Caught you up — 2 things happened.");
    expect(markup.indexOf("Messi gives Argentina the lead")).toBeLessThan(
      markup.indexOf("Yellow card · France"),
    );
    expect(markup).toContain('aria-label="Missed events in order"');
  });

  it("labels stale and offline score states without claiming live data", () => {
    const stale = render(FreshnessBanner, {
      age: "2 min ago",
      asOf: "67′",
      status: "stale" as const,
    });
    const offline = render(FreshnessBanner, {
      age: "4 min ago",
      asOf: "67′",
      status: "offline" as const,
    });

    expect(stale).toContain('role="status"');
    expect(stale).toContain("showing cached score");
    expect(offline).toContain('role="alert"');
    expect(offline).toContain("Offline · current score cached");
    expect(`${stale}${offline}`).not.toContain("LIVE");
  });

  it("closes the journey with an emotional, shareable and factual Match Memory", () => {
    const props: MatchMemoryProps = {
      moments: [
        {
          id: "goal-23",
          kind: "goal",
          minute: "23′",
          team: argentina,
          title: "Messi broke the deadlock",
        },
        {
          detail: "The goal stood after review",
          id: "var-25",
          kind: "var",
          minute: "25′",
          title: "One nervy VAR",
        },
      ],
      onReplay: () => undefined,
      onShare: () => undefined,
      roomResult: {
        players: 4,
        points: 800,
        position: 1,
        roomName: "Finals Night",
      },
      score: { ...score, away: 1, home: 2 },
      stats: [{ away: 4, home: 7, label: "Shots on target" }],
      summary: "Two goals, one nervy VAR, a night to keep.",
      supportedTeam: argentina,
      truth: { ...truth, minute: "FT", revision: 17 },
    };
    const markup = render(
      MatchMemory as FunctionComponent<MatchMemoryProps>,
      props,
    );

    expect(markup).toContain('data-state="match-memory"');
    expect(markup).toContain("Full time · finalised");
    expect(markup).toContain(props.summary);
    expect(markup).toContain("1st");
    expect(markup).toContain("800 points");
    expect(markup).toContain("No prizes · no money");
    expect(markup).toContain("Share this memory");
    expect(markup).toContain("Replay match moments");
  });
});
