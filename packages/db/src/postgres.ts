import postgres, { type Sql, type TransactionSql } from "postgres";

import {
  createArchiveRepository,
  type ArchiveRepository,
} from "./archive-repositories.js";
import {
  createArchiveImportJobRepository,
  createFeaturedReplayRepository,
  type ArchiveImportJobRepository,
  type FeaturedReplayRepository,
} from "./archive-import-job-repository.js";
import {
  createCommentaryJobRepository,
  type CommentaryJobRepository,
} from "./commentary-job-repository.js";
import type { AppliedMigration, MigrationDefinition } from "./migrations.js";
import {
  createCommentaryArtifactRepository,
  createFixtureTruthRepository,
  createOutboxRepository,
  createSourceStateRepository,
  type CommentaryArtifactRepository,
  type FixtureTruthRepository,
  type OutboxRepository,
  type SourceStateRepository,
} from "./repositories.js";
import {
  createExperienceRepository,
  createFanRepository,
  createMemoryRepository,
  createPushDeviceRepository,
  createRoomAggregateRepository,
  type ExperienceRepository,
  type FanRepository,
  type MemoryRepository,
  type PushDeviceRepository,
  type RoomAggregateRepository,
} from "./product-repositories.js";
import {
  createFixtureReadRepository,
  type FixtureReadRepository,
} from "./fixture-read-repository.js";
import {
  createTeamCatalogRepository,
  type TeamCatalogRepository,
} from "./team-catalog-repository.js";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type MigrationStore,
} from "./runtime.js";

type QueryRow = Record<string, unknown>;

interface QueryExecutor {
  unsafe(
    query: string,
    parameters?: readonly unknown[],
  ): Promise<readonly QueryRow[]>;
}

export interface PostgresClient extends QueryExecutor {
  begin<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T>;
  end(options: { timeout: number }): Promise<void>;
}

export interface ApplicationDatabase extends DatabaseRuntime {
  archive: ArchiveRepository;
  archiveImportJobs: ArchiveImportJobRepository;
  commentaryArtifacts: CommentaryArtifactRepository;
  commentaryJobs: CommentaryJobRepository;
  experiences: ExperienceRepository;
  fans: FanRepository;
  featuredReplays: FeaturedReplayRepository;
  fixtureReads: FixtureReadRepository;
  fixtureTruth: FixtureTruthRepository;
  memories: MemoryRepository;
  outbox: OutboxRepository;
  pushDevices: PushDeviceRepository;
  rooms: RoomAggregateRepository;
  sourceState: SourceStateRepository;
  teamCatalog: TeamCatalogRepository;
}

function adaptQueryExecutor(executor: Sql | TransactionSql): QueryExecutor {
  return {
    unsafe: async (query, parameters) =>
      executor.unsafe<QueryRow[]>(
        query,
        parameters ? ([...parameters] as never[]) : undefined,
      ),
  };
}

function adaptPostgresClient(client: Sql): PostgresClient {
  const executor = adaptQueryExecutor(client);

  return {
    begin: async (work) => {
      const result = await client.begin(async (transaction) => ({
        value: await work(adaptQueryExecutor(transaction)),
      }));

      return result.value;
    },
    end: async (options) => client.end(options),
    unsafe: executor.unsafe,
  };
}

const advisoryLockQuery = "SELECT pg_advisory_xact_lock(1835101038);";
const ensureLedgerQuery = `
CREATE TABLE IF NOT EXISTS public.matchsense_schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  checksum text NOT NULL CHECK (length(checksum) = 64),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`.trim();
const readLedgerQuery = `
SELECT version, checksum
FROM public.matchsense_schema_migrations
ORDER BY version ASC;`.trim();
const inspectLedgerQuery = `
SELECT to_regclass('public.matchsense_schema_migrations') IS NOT NULL AS ledger_exists;`.trim();
const insertLedgerQuery = `
INSERT INTO public.matchsense_schema_migrations (version, checksum)
VALUES ($1, $2);`.trim();

function parseAppliedMigrations(rows: readonly QueryRow[]): AppliedMigration[] {
  return rows.map((row) => {
    if (typeof row.version !== "number" || typeof row.checksum !== "string") {
      throw new Error("Database migration ledger is invalid");
    }

    return { checksum: row.checksum, version: row.version };
  });
}

export function createPostgresMigrationStore(
  client: PostgresClient,
): MigrationStore {
  return {
    close: async () => client.end({ timeout: 5 }),
    inspectAppliedMigrations: async () => {
      const rows = await client.unsafe(inspectLedgerQuery);
      const ledgerExists = rows[0]?.ledger_exists === true;

      if (!ledgerExists) {
        return { ledgerExists: false };
      }

      return {
        applied: parseAppliedMigrations(await client.unsafe(readLedgerQuery)),
        ledgerExists: true,
      };
    },
    ping: async () => {
      await client.unsafe("SELECT 1;");
    },
    withMigrationLock: async (work) =>
      client.begin(async (transaction) => {
        await transaction.unsafe(advisoryLockQuery);

        return work({
          ensureLedger: async () => {
            await transaction.unsafe(ensureLedgerQuery);
          },
          executeMigration: async (migration: MigrationDefinition) => {
            await transaction.unsafe(migration.sql);
          },
          readAppliedMigrations: async () =>
            parseAppliedMigrations(await transaction.unsafe(readLedgerQuery)),
          recordMigration: async (migration: MigrationDefinition) => {
            await transaction.unsafe(insertLedgerQuery, [
              migration.version,
              migration.checksum,
            ]);
          },
        });
      }),
  };
}

export function createApplicationDatabase(
  client: PostgresClient,
): ApplicationDatabase {
  const runtime = createDatabaseRuntime({
    store: createPostgresMigrationStore(client),
  });

  return Object.assign(runtime, {
    archive: createArchiveRepository(client),
    archiveImportJobs: createArchiveImportJobRepository(client),
    commentaryArtifacts: createCommentaryArtifactRepository(client),
    commentaryJobs: createCommentaryJobRepository(client),
    experiences: createExperienceRepository(client),
    fans: createFanRepository(client),
    featuredReplays: createFeaturedReplayRepository(client),
    fixtureReads: createFixtureReadRepository(client),
    fixtureTruth: createFixtureTruthRepository(client),
    memories: createMemoryRepository(client),
    outbox: createOutboxRepository(client),
    pushDevices: createPushDeviceRepository(client),
    rooms: createRoomAggregateRepository(client),
    sourceState: createSourceStateRepository(client),
    teamCatalog: createTeamCatalogRepository(client),
  });
}

export function createPostgresDatabase(
  databaseUrl: string,
): ApplicationDatabase {
  const client = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 20,
    max: 10,
  });

  return createApplicationDatabase(adaptPostgresClient(client));
}
