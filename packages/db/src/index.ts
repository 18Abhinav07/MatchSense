export { assertDestructiveIntegrationTarget } from "./integration-guard.js";
export type { DestructiveIntegrationTargetOptions } from "./integration-guard.js";
export {
  migrationCatalog,
  MigrationStateError,
  planMigrations,
} from "./migrations.js";
export type {
  AppliedMigration,
  MigrationDefinition,
  MigrationStateErrorCode,
} from "./migrations.js";
export { createDatabaseRuntime } from "./runtime.js";
export type {
  AppliedMigrationInspection,
  DatabaseReadiness,
  DatabaseRuntime,
  MigrationStore,
  MigrationTransaction,
} from "./runtime.js";
export {
  createApplicationDatabase,
  createPostgresDatabase,
  createPostgresMigrationStore,
} from "./postgres.js";
export type { ApplicationDatabase, PostgresClient } from "./postgres.js";
export { createArchiveRepository } from "./archive-repositories.js";
export type {
  ArchiveManifest,
  ArchiveManifestStatus,
  ArchiveMode,
  ArchiveProvenance,
  ArchiveRepository,
  DurableRawRetention,
  DurableSourceDelivery,
  InsertDeliveryResult,
  RightsGrant,
  RightsGrantWrite,
  VerifyArchiveInput,
} from "./archive-repositories.js";
export { createCommentaryJobRepository } from "./commentary-job-repository.js";
export type {
  CommentaryJob,
  CommentaryJobInput,
  CommentaryJobRepository,
  CommentaryJobStatus,
  CompletedCommentaryJob,
  FailedCommentaryJob,
} from "./commentary-job-repository.js";
export {
  createCommentaryArtifactRepository,
  createFixtureTruthRepository,
  createOutboxRepository,
  createSourceStateRepository,
  FixtureRevisionConflictError,
} from "./repositories.js";
export type {
  AdvanceSourceCursorResult,
  CommentaryArtifactKey,
  CommentaryArtifactRecord,
  CommentaryArtifactRepository,
  CommitFixtureScheduleInput,
  CommitFixtureScheduleResult,
  CommitRawSourceRecordInput,
  CommitRawSourceRecordResult,
  CommitSourceChangeInput,
  CommitSourceChangeResult,
  ConsumerReceiptKey,
  FencedSourceLeaseKey,
  FixtureEventRecord,
  FixtureProjectionRecord,
  FixtureRecord,
  FixtureTruthRepository,
  FixtureUpsert,
  OutboxRecord,
  OutboxRepository,
  OutboxWrite,
  PersistenceMode,
  PersistenceProvenance,
  ProcessSourceEnvelopeInput,
  ProcessSourceEnvelopeResult,
  QueryRow,
  RawSourceRecordWrite,
  RepositoryClient,
  SourceDeliveryIntent,
  SourceEnvelopeCommitPlan,
  SourceCursorRecord,
  SourceFence,
  SourceLeaseRecord,
  SourceStateRepository,
  SourceStreamKey,
  SqlExecutor,
} from "./repositories.js";
export {
  createExperienceRepository,
  createFanRepository,
  createMemoryRepository,
  createPushDeviceRepository,
  createRoomAggregateRepository,
} from "./product-repositories.js";
export type {
  ExperienceBeatRecord,
  ExperienceJourney,
  ExperienceRepository,
  ExperienceRunRecord,
  ExperienceRunStatus,
  FanFollowRecord,
  FanRecord,
  FanRepository,
  FanSessionRecord,
  MemoryRecord,
  MemoryRepository,
  PushDeliveryStatus,
  PushDeviceRecord,
  PushDeviceRepository,
  RoomAggregateRecord,
  RoomAggregateRepository,
  RoomStatus,
} from "./product-repositories.js";
export { createInMemoryFixtureTruthRepository } from "./in-memory-fixture-truth.js";
export type {
  InMemoryFixtureTruthInspection,
  InMemoryFixtureTruthRepository,
} from "./in-memory-fixture-truth.js";
export { isDirectExecution, runDatabaseCli } from "./cli.js";
export type { DatabaseCliOptions } from "./cli.js";
