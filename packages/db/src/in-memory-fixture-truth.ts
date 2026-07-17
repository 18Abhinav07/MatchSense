import type {
  FixtureEventRecord,
  FixtureProjectionRecord,
  FixtureTruthRepository,
  PersistenceMode,
  ProcessSourceEnvelopeInput,
  ProcessSourceEnvelopeResult,
  RawSourceRecordWrite,
} from "./repositories.js";

export interface InMemoryFixtureTruthInspection {
  events: readonly FixtureEventRecord[];
  moments: readonly {
    id: string;
    kind: string;
    revisions: readonly number[];
  }[];
  outbox: readonly {
    id: string;
    idempotencyKey: string;
    payload: unknown;
    topic: string;
  }[];
  projection: FixtureProjectionRecord | null;
  sourceRecords: readonly RawSourceRecordWrite[];
}

export interface InMemoryFixtureTruthRepository extends Pick<
  FixtureTruthRepository,
  "processSourceEnvelope"
> {
  inspect(input: {
    fixtureId: string;
    mode: PersistenceMode;
  }): InMemoryFixtureTruthInspection;
  seedFixture(input: {
    fixtureId: string;
    mode: PersistenceMode;
    projection?: FixtureProjectionRecord | null;
  }): void;
}

interface MutableFixtureState {
  eventIds: Set<string>;
  events: FixtureEventRecord[];
  moments: Map<string, { kind: string; revisions: Map<number, unknown> }>;
  outbox: {
    id: string;
    idempotencyKey: string;
    payload: unknown;
    topic: string;
  }[];
  outboxIds: Set<string>;
  outboxKeys: Set<string>;
  projection: FixtureProjectionRecord | null;
  sourceDedupeKeys: Set<string>;
  sourceRecords: RawSourceRecordWrite[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stateKey(mode: PersistenceMode, fixtureId: string) {
  return `${mode}:${fixtureId}`;
}

function rawDedupeKey(input: ProcessSourceEnvelopeInput) {
  return `${input.raw.source}:${input.raw.dedupeKey}`;
}

function newState(
  projection: FixtureProjectionRecord | null,
): MutableFixtureState {
  return {
    eventIds: new Set(),
    events: [],
    moments: new Map(),
    outbox: [],
    outboxIds: new Set(),
    outboxKeys: new Set(),
    projection: projection ? clone(projection) : null,
    sourceDedupeKeys: new Set(),
    sourceRecords: [],
  };
}

function cloneState(state: MutableFixtureState): MutableFixtureState {
  return {
    eventIds: new Set(state.eventIds),
    events: clone(state.events),
    moments: new Map(
      [...state.moments.entries()].map(([id, moment]) => [
        id,
        {
          kind: moment.kind,
          revisions: new Map(
            [...moment.revisions.entries()].map(([revision, payload]) => [
              revision,
              clone(payload),
            ]),
          ),
        },
      ]),
    ),
    outbox: clone(state.outbox),
    outboxIds: new Set(state.outboxIds),
    outboxKeys: new Set(state.outboxKeys),
    projection: state.projection ? clone(state.projection) : null,
    sourceDedupeKeys: new Set(state.sourceDedupeKeys),
    sourceRecords: clone(state.sourceRecords),
  };
}

export function createInMemoryFixtureTruthRepository(): InMemoryFixtureTruthRepository {
  const fixtures = new Map<string, MutableFixtureState>();
  const tails = new Map<string, Promise<void>>();

  const serialized = async <T>(key: string, work: () => T | Promise<T>) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };

  return {
    inspect: (input) => {
      const state = fixtures.get(stateKey(input.mode, input.fixtureId));
      if (!state) throw new Error("Fixture does not exist");
      return {
        events: clone(state.events),
        moments: [...state.moments.entries()]
          .map(([id, moment]) => ({
            id,
            kind: moment.kind,
            revisions: [...moment.revisions.keys()].sort(
              (left, right) => left - right,
            ),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        outbox: clone(state.outbox),
        projection: state.projection ? clone(state.projection) : null,
        sourceRecords: clone(state.sourceRecords),
      };
    },
    processSourceEnvelope: async (
      input,
    ): Promise<ProcessSourceEnvelopeResult> => {
      if (input.mode === "live" && !input.sourceFence) {
        return { kind: "fenced" };
      }
      const key = stateKey(input.mode, input.fixtureId);
      return serialized(key, () => {
        const state = fixtures.get(key);
        if (!state) throw new Error("Fixture does not exist");
        const dedupeKey = rawDedupeKey(input);
        if (state.sourceDedupeKeys.has(dedupeKey)) {
          return { kind: "duplicate" };
        }

        const plan = input.derive(
          state.projection ? clone(state.projection) : null,
        );
        const storedRaw: RawSourceRecordWrite = {
          ...clone(input.raw),
          payload: input.mode === "live" ? null : clone(input.raw.payload),
        };
        if (!plan) {
          const next = cloneState(state);
          next.sourceDedupeKeys.add(dedupeKey);
          next.sourceRecords.push(storedRaw);
          fixtures.set(key, next);
          return { kind: "accepted_no_change" };
        }

        const nextRevision = (state.projection?.revision ?? 0) + 1;
        if (plan.projection.revision !== nextRevision) {
          throw new Error("Derived projection must advance exactly once");
        }
        if (plan.moment && plan.moment.revision !== nextRevision) {
          throw new Error("Derived Moment must use the fixture revision");
        }
        if (state.eventIds.has(plan.event.id)) {
          throw new Error("Fixture event identity already exists");
        }
        for (const message of plan.outbox) {
          if (
            state.outboxIds.has(message.id) ||
            state.outboxKeys.has(message.idempotencyKey)
          ) {
            throw new Error("Outbox identity already exists");
          }
        }

        const eventSequence = state.events.length + 1;
        const projection: FixtureProjectionRecord = {
          fixtureId: input.fixtureId,
          mode: input.mode,
          payload: clone(plan.projection.payload),
          revision: plan.projection.revision,
          sourceSequence: input.raw.sourceSequence,
          updatedAt: input.raw.receivedAt,
        };

        const next = cloneState(state);
        next.sourceDedupeKeys.add(dedupeKey);
        next.sourceRecords.push(storedRaw);
        next.projection = projection;
        next.eventIds.add(plan.event.id);
        next.events.push({
          createdAt: input.raw.receivedAt,
          eventId: plan.event.id,
          eventType: plan.event.type,
          fixtureId: input.fixtureId,
          mode: input.mode,
          payload: clone(plan.event.payload),
          sequence: eventSequence,
        });
        if (plan.moment) {
          const moment = next.moments.get(plan.moment.id) ?? {
            kind: plan.moment.kind,
            revisions: new Map<number, unknown>(),
          };
          moment.revisions.set(
            plan.moment.revision,
            clone(plan.moment.payload),
          );
          next.moments.set(plan.moment.id, moment);
        }
        for (const message of plan.outbox) {
          next.outboxIds.add(message.id);
          next.outboxKeys.add(message.idempotencyKey);
          next.outbox.push({
            id: message.id,
            idempotencyKey: message.idempotencyKey,
            payload: clone(message.payload),
            topic: message.topic,
          });
        }
        fixtures.set(key, next);
        return {
          eventSequence,
          kind: "committed",
          revision: plan.projection.revision,
        };
      });
    },
    seedFixture: (input) => {
      const key = stateKey(input.mode, input.fixtureId);
      if (fixtures.has(key)) throw new Error("Fixture already exists");
      fixtures.set(key, newState(input.projection ?? null));
    },
  };
}
