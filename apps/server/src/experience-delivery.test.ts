import { describe, expect, it, vi } from "vitest";

import {
  createExperienceDelivery,
  experiencePushCandidate,
} from "./experience-delivery.js";

function payload(kind = "var.stands") {
  return {
    deliveryIntent: "realtime",
    event: {
      moment: {
        celebratesGoal: true,
        eventTeam: "ARG",
        familyId: "run-1:event:opening-goal",
        fixtureId: "experience:run-1",
        kind,
        minute: "13'",
        occurredAt: "2026-07-19T12:00:50.000Z",
        provenance: "synthetic_txline_shaped",
        revision: 4,
        score: { away: 0, home: 1 },
        status: "confirmed",
      },
      snapshot: { updatedAt: "2026-07-19T12:00:50.000Z" },
    },
    mode: "demo",
  };
}

describe("Experience-only delivery adapter", () => {
  it("labels a confirmed VAR-stands goal and preserves exact revision", () => {
    expect(experiencePushCandidate(payload())).toEqual({
      input: expect.objectContaining({
        eventKind: "goal",
        familyId: "run-1:event:opening-goal",
        fixtureId: "experience:run-1",
        revision: 4,
        title: expect.stringContaining("EXPERIENCE"),
      }),
      runId: "run-1",
    });
  });

  it("rejects provisional, recorded, and non-alert Experience events", () => {
    expect(
      experiencePushCandidate({
        ...payload(),
        mode: "live",
      }),
    ).toBeNull();
    expect(
      experiencePushCandidate({
        ...payload(),
        event: {
          ...payload().event,
          moment: { ...payload().event.moment, status: "provisional" },
        },
      }),
    ).toBeNull();
    expect(experiencePushCandidate(payload("card.yellow"))).toBeNull();
  });

  it("targets only the exact run owner and never a live follower query", async () => {
    const deliverExperienceToFans = vi.fn(async () => ({
      accepted: 1,
      attempted: 1,
    }));
    const delivery = createExperienceDelivery({
      experiences: {
        getRun: async () => ({
          completedAt: null,
          createdAt: "2026-07-19T12:00:00.000Z",
          fixtureId: "experience:run-1",
          fixtureMode: "demo",
          id: "run-1",
          journey: "experience_match",
          kickoffAt: "2026-07-19T12:00:00.000Z",
          nextBeatIndex: 4,
          ownerFanId: "fan-1",
          status: "live",
          templateId: "five-minute-match",
          templateVersion: 2,
          updatedAt: "2026-07-19T12:00:50.000Z",
          version: 4,
        }),
      },
      push: { deliverExperienceToFans },
    });

    await expect(delivery.deliver(payload())).resolves.toEqual({
      accepted: 1,
      attempted: 1,
    });
    expect(deliverExperienceToFans).toHaveBeenCalledWith(
      expect.objectContaining({ fixtureId: "experience:run-1" }),
      ["fan-1"],
    );
  });
});
