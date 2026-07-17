export interface MomentActivation {
  fixtureId: string;
  momentIdentity: string;
  revision: number;
  url: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMomentActivation(
  value: unknown,
  origin: string,
): MomentActivation | null {
  const input = record(value);
  if (!input || input.type !== "matchsense:open-moment") return null;
  if (
    typeof input.url !== "string" ||
    typeof input.fixtureId !== "string" ||
    typeof input.momentIdentity !== "string" ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 1
  ) {
    return null;
  }

  let target: URL;
  try {
    target = new URL(input.url, origin);
  } catch {
    return null;
  }
  if (target.origin !== origin || target.search || target.hash) return null;

  const match = target.pathname.match(
    /^\/matches\/([^/]+)\/moments\/([^/]+)$/u,
  );
  if (!match?.[1] || !match[2]) return null;

  let fixtureId: string;
  let momentIdentity: string;
  try {
    fixtureId = decodeURIComponent(match[1]);
    momentIdentity = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (
    fixtureId !== input.fixtureId ||
    momentIdentity !== input.momentIdentity ||
    !momentIdentity.endsWith(`:${String(input.revision)}`)
  ) {
    return null;
  }

  return {
    fixtureId,
    momentIdentity,
    revision: input.revision as number,
    url: target.pathname,
  };
}
