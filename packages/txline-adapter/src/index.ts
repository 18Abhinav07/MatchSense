import type {
  SourceFact,
  SyntheticSourceEnvelope,
} from "@matchsense/contracts";

function assertNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

/**
 * Adapts the deliberately minimal synthetic replay envelope. It does not claim
 * to model an undocumented TxLINE payload and only passes facts we authored.
 */
export function adaptSyntheticEnvelope(
  envelope: SyntheticSourceEnvelope,
): SourceFact {
  if (envelope.provenance !== "synthetic_txline_shaped") {
    throw new Error("Only explicitly synthetic replay data is accepted");
  }
  assertNonNegativeInteger(envelope.supportedFact.homeGoals, "homeGoals");
  assertNonNegativeInteger(envelope.supportedFact.awayGoals, "awayGoals");

  return {
    fixtureId: envelope.fixtureId,
    minute: envelope.supportedFact.minute,
    provenance: envelope.provenance,
    receivedAt: envelope.receivedAt,
    score: {
      away: envelope.supportedFact.awayGoals,
      home: envelope.supportedFact.homeGoals,
    },
    sourceEnvelopeId: envelope.id,
    type: "score_snapshot",
  };
}
