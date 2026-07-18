import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { FixtureBucket, FixtureReadRepository } from "@matchsense/db";

const fixtureId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_:%-]+$/u);
const bucket = z.enum(["upcoming", "live", "final"]);

export interface FixtureReadRouteDependencies {
  reads: FixtureReadRepository;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "fixture_not_found" });
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ error: "fixture_request_invalid" });
}

function parseMomentIdentity(identity: string) {
  const separator = identity.lastIndexOf(":");
  if (separator < 1 || separator === identity.length - 1) return null;
  const familyId = identity.slice(0, separator);
  const revisionText = identity.slice(separator + 1);
  if (!/^[1-9][0-9]*$/u.test(revisionText)) return null;
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision)) return null;
  return { familyId, revision };
}

export function registerFixtureReadRoutes(
  app: FastifyInstance,
  dependencies: FixtureReadRouteDependencies,
) {
  app.get<{ Querystring: { bucket?: string; limit?: string } }>(
    "/api/v1/fixtures",
    async (request, reply) => {
      const parsedBucket =
        request.query.bucket === undefined
          ? undefined
          : bucket.safeParse(request.query.bucket);
      if (parsedBucket && !parsedBucket.success) return invalid(reply);
      const parsedLimit =
        request.query.limit === undefined
          ? undefined
          : Number(request.query.limit);
      if (
        parsedLimit !== undefined &&
        (!Number.isSafeInteger(parsedLimit) ||
          parsedLimit < 1 ||
          parsedLimit > 500)
      ) {
        return invalid(reply);
      }
      const fixtures = await dependencies.reads.listFixtures({
        ...(parsedBucket?.success
          ? { bucket: parsedBucket.data as FixtureBucket }
          : {}),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      });
      return reply.header("Cache-Control", "no-store").send({ fixtures });
    },
  );

  app.get<{ Params: { fixtureId: string } }>(
    "/api/v1/fixtures/:fixtureId",
    async (request, reply) => {
      const parsed = fixtureId.safeParse(request.params.fixtureId);
      if (!parsed.success) return invalid(reply);
      const fixture = await dependencies.reads.getFixture(parsed.data);
      return fixture
        ? reply.header("Cache-Control", "no-store").send(fixture)
        : notFound(reply);
    },
  );

  app.get<{ Params: { fixtureId: string; identity: string } }>(
    "/api/v1/fixtures/:fixtureId/moments/:identity",
    async (request, reply) => {
      const parsedFixture = fixtureId.safeParse(request.params.fixtureId);
      const identity = parseMomentIdentity(request.params.identity);
      if (!parsedFixture.success || !identity) return invalid(reply);
      const moment = await dependencies.reads.readMoment({
        familyId: identity.familyId,
        fixtureId: parsedFixture.data,
        revision: identity.revision,
      });
      return moment
        ? reply.header("Cache-Control", "no-store").send(moment)
        : notFound(reply);
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/v1/history",
    async (request, reply) => {
      const parsedLimit =
        request.query.limit === undefined
          ? undefined
          : Number(request.query.limit);
      if (
        parsedLimit !== undefined &&
        (!Number.isSafeInteger(parsedLimit) ||
          parsedLimit < 1 ||
          parsedLimit > 500)
      ) {
        return invalid(reply);
      }
      return reply.header("Cache-Control", "no-store").send({
        fixtures: await dependencies.reads.readHistory(
          parsedLimit === undefined ? {} : { limit: parsedLimit },
        ),
      });
    },
  );

  app.get<{ Params: { fixtureId: string } }>(
    "/api/v1/fixtures/:fixtureId/memory",
    async (request, reply) => {
      const parsed = fixtureId.safeParse(request.params.fixtureId);
      if (!parsed.success) return invalid(reply);
      const memory = await dependencies.reads.readMemory(parsed.data);
      return memory
        ? reply.header("Cache-Control", "no-store").send({ memory })
        : notFound(reply);
    },
  );
}
