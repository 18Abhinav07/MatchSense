export interface DestructiveIntegrationTargetOptions {
  allowDestructive: string | undefined;
  databaseUrl: string | undefined;
}

const rejectedTargetMessage =
  "Destructive database integration target is not allowed";

function rejectTarget(): never {
  throw new Error(rejectedTargetMessage);
}

export function assertDestructiveIntegrationTarget(
  options: DestructiveIntegrationTargetOptions,
) {
  if (
    options.allowDestructive !== "true" ||
    !options.databaseUrl ||
    !URL.canParse(options.databaseUrl)
  ) {
    return rejectTarget();
  }

  const parsed = new URL(options.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return rejectTarget();
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return rejectTarget();
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*_test$/u.test(databaseName)) {
    return rejectTarget();
  }

  return { databaseName, databaseUrl: options.databaseUrl };
}
