import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  CommentaryArtifactRepository,
  FixtureTruthRepository,
} from "@matchsense/db";

const fixtureIdPattern = /^[A-Za-z0-9_:%-]{1,120}$/u;
const languagePattern = /^[a-z]{2,8}$/u;
const voicePattern = /^[A-Za-z0-9_-]{1,80}$/u;
const templatePattern = /^[A-Za-z0-9_.-]{1,120}$/u;

export interface CommentaryArtifactRouteDependencies {
  artifacts: Pick<CommentaryArtifactRepository, "get">;
  truth: Pick<FixtureTruthRepository, "eventsAfter">;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "commentary_not_ready" });
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ error: "commentary_request_invalid" });
}

function parseIdentity(value: string) {
  const separator = value.lastIndexOf(":");
  if (separator < 1 || separator === value.length - 1) return null;
  const familyId = value.slice(0, separator);
  const revisionText = value.slice(separator + 1);
  if (
    !fixtureIdPattern.test(familyId) ||
    !/^[1-9][0-9]*$/u.test(revisionText)
  ) {
    return null;
  }
  const revision = Number(revisionText);
  return Number.isSafeInteger(revision) ? { familyId, revision } : null;
}

function currentRevision(
  payload: unknown,
  fixtureId: string,
  familyId: string,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const event = payload as { moment?: unknown };
  const moment = event.moment;
  if (!moment || typeof moment !== "object" || Array.isArray(moment)) {
    return null;
  }
  const candidate = moment as {
    familyId?: unknown;
    fixtureId?: unknown;
    revision?: unknown;
    status?: unknown;
  };
  return candidate.familyId === familyId &&
    candidate.fixtureId === fixtureId &&
    candidate.status === "confirmed" &&
    typeof candidate.revision === "number" &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision > 0
    ? candidate.revision
    : null;
}

async function isCurrentConfirmedMoment(
  dependencies: CommentaryArtifactRouteDependencies,
  input: { familyId: string; fixtureId: string; revision: number },
) {
  const events = await dependencies.truth.eventsAfter({
    afterSequence: 0,
    fixtureId: input.fixtureId,
    limit: 1_000,
    mode: "live",
  });
  const latest = events.reduce<number | null>((current, event) => {
    const revision = currentRevision(
      event.payload,
      input.fixtureId,
      input.familyId,
    );
    return revision !== null && (current === null || revision > current)
      ? revision
      : current;
  }, null);
  return latest === input.revision;
}

/**
 * Serves a shared, pre-generated artifact only for the latest live canonical
 * revision. Archived/replay traffic deliberately has no query-mode escape
 * hatch, so it cannot wake TTS or surface an old match as a live call.
 */
export function registerCommentaryArtifactRoutes(
  app: FastifyInstance,
  dependencies: CommentaryArtifactRouteDependencies,
) {
  app.get<{
    Params: { fixtureId: string; identity: string };
    Querystring: {
      language?: string;
      mode?: string;
      templateVersion?: string;
      voice?: string;
    };
  }>(
    "/api/v1/fixtures/:fixtureId/moments/:identity/audio",
    async (request, reply) => {
      const parsed = parseIdentity(request.params.identity);
      if (
        !fixtureIdPattern.test(request.params.fixtureId) ||
        !parsed ||
        request.query.mode !== undefined
      ) {
        return invalid(reply);
      }
      const language = request.query.language ?? "en";
      const voice = request.query.voice ?? "Kore";
      const templateVersion = request.query.templateVersion ?? "factual-v1";
      if (
        !languagePattern.test(language) ||
        !voicePattern.test(voice) ||
        !templatePattern.test(templateVersion)
      ) {
        return invalid(reply);
      }
      if (
        !(await isCurrentConfirmedMoment(dependencies, {
          familyId: parsed.familyId,
          fixtureId: request.params.fixtureId,
          revision: parsed.revision,
        }))
      ) {
        return notFound(reply);
      }
      const artifact = await dependencies.artifacts.get({
        fixtureId: request.params.fixtureId,
        language,
        mode: "live",
        momentId: parsed.familyId,
        momentRevision: parsed.revision,
        templateVersion,
        voice,
      });
      if (!artifact || artifact.bytes.byteLength === 0) return notFound(reply);
      return reply
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", "inline")
        .header("Content-Type", artifact.mediaType)
        .header("X-Content-Type-Options", "nosniff")
        .send(Buffer.from(artifact.bytes));
    },
  );
}
