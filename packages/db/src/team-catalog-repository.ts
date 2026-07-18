import type { QueryRow, RepositoryClient } from "./repositories.js";

/**
 * A public team identity persisted from the live TxLINE tournament schedule.
 * This model intentionally contains no schedule, event, or raw-source payload.
 */
export interface TeamCatalogEntry {
  code: string;
  name: string;
  participantId: string;
  sourceTimestampMs: number;
}

export interface TeamCatalogRepository {
  list(): Promise<readonly TeamCatalogEntry[]>;
  upsert(entries: readonly TeamCatalogEntry[]): Promise<void>;
}

const codePattern = /^[A-Z0-9][A-Z0-9-]{1,19}$/u;
const selectColumns = "participant_id, code, name, source_timestamp_ms";

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Team catalogue ${label} is required`);
  }
  return value.trim();
}

function sourceTimestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new Error("Team catalogue source timestamp is invalid");
  }
  return parsed as number;
}

function validateEntry(entry: TeamCatalogEntry): TeamCatalogEntry {
  const participantId = requiredString(entry.participantId, "participant id");
  const name = requiredString(entry.name, "name");
  const code = requiredString(entry.code, "code");
  if (!codePattern.test(code)) {
    throw new Error("Team catalogue code is invalid");
  }
  return {
    code,
    name,
    participantId,
    sourceTimestampMs: sourceTimestamp(entry.sourceTimestampMs),
  };
}

/**
 * Multiple schedule pages can contain the same participant. Keep only its
 * newest source observation and reject a same-time contradiction instead of
 * silently choosing an arbitrary team identity.
 */
function normalizeEntries(
  entries: readonly TeamCatalogEntry[],
): readonly TeamCatalogEntry[] {
  if (!Array.isArray(entries)) {
    throw new Error("Team catalogue entries must be an array");
  }

  const byParticipantId = new Map<string, TeamCatalogEntry>();
  for (const input of entries) {
    const entry = validateEntry(input);
    const previous = byParticipantId.get(entry.participantId);
    if (!previous || entry.sourceTimestampMs > previous.sourceTimestampMs) {
      byParticipantId.set(entry.participantId, entry);
      continue;
    }
    if (
      entry.sourceTimestampMs === previous.sourceTimestampMs &&
      (entry.code !== previous.code || entry.name !== previous.name)
    ) {
      throw new Error("Team catalogue same timestamp has conflicting identity");
    }
  }

  const participantIdByCode = new Map<string, string>();
  for (const entry of byParticipantId.values()) {
    const existingParticipantId = participantIdByCode.get(entry.code);
    if (
      existingParticipantId !== undefined &&
      existingParticipantId !== entry.participantId
    ) {
      throw new Error("Team catalogue code maps to multiple participant ids");
    }
    participantIdByCode.set(entry.code, entry.participantId);
  }

  return [...byParticipantId.values()].toSorted(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.participantId.localeCompare(right.participantId),
  );
}

function parseEntry(row: QueryRow): TeamCatalogEntry {
  return validateEntry({
    code: requiredString(row.code, "code"),
    name: requiredString(row.name, "name"),
    participantId: requiredString(row.participant_id, "participant id"),
    sourceTimestampMs: sourceTimestamp(row.source_timestamp_ms),
  });
}

export function createTeamCatalogRepository(
  client: RepositoryClient,
): TeamCatalogRepository {
  return {
    list: async () => {
      const rows = await client.unsafe(
        `SELECT ${selectColumns}
FROM matchsense.team_catalog_entries
ORDER BY code ASC, participant_id ASC;`,
      );
      return rows.map(parseEntry);
    },
    upsert: async (entries) => {
      const normalized = normalizeEntries(entries);
      if (normalized.length === 0) return;

      await client.begin(async (transaction) => {
        for (const entry of normalized) {
          await transaction.unsafe(
            `INSERT INTO matchsense.team_catalog_entries (
  participant_id, code, name, source_timestamp_ms
)
VALUES ($1, $2, $3, $4)
ON CONFLICT (participant_id) DO UPDATE
SET name = EXCLUDED.name,
    source_timestamp_ms = EXCLUDED.source_timestamp_ms,
    updated_at = clock_timestamp()
WHERE EXCLUDED.source_timestamp_ms > matchsense.team_catalog_entries.source_timestamp_ms;`,
            [
              entry.participantId,
              entry.code,
              entry.name,
              entry.sourceTimestampMs,
            ],
          );
        }
      });
    },
  };
}
