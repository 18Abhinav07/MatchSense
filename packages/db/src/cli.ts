import { pathToFileURL } from "node:url";

import { createPostgresDatabase } from "./postgres.js";
import type { DatabaseRuntime } from "./runtime.js";

export interface DatabaseCliOptions {
  args: readonly string[];
  createRuntime: (databaseUrl: string) => DatabaseRuntime;
  environment: Record<string, string | undefined>;
  writeError: (message: string) => void;
  writeOutput: (message: string) => void;
}

function validDatabaseUrl(value: string | undefined): value is string {
  if (!value || !URL.canParse(value)) {
    return false;
  }

  return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
}

export async function runDatabaseCli(
  options: DatabaseCliOptions,
): Promise<number> {
  const command = options.args[0];
  const databaseUrl = options.environment.DATABASE_URL;

  if (!validDatabaseUrl(databaseUrl)) {
    options.writeError("Database configuration is invalid\n");
    return 1;
  }

  if (command !== "check" && command !== "migrate") {
    options.writeError("Database command is invalid\n");
    return 1;
  }

  let runtime: DatabaseRuntime;
  try {
    runtime = options.createRuntime(databaseUrl);
  } catch {
    options.writeError(`Database ${command} failed\n`);
    return 1;
  }

  let exitCode = 1;
  let successOutput: string | undefined;
  try {
    if (command === "check") {
      const readiness = await runtime.check();

      if (readiness.databaseReachable && readiness.migrationsCurrent) {
        successOutput = "Database migrations are current\n";
        exitCode = 0;
      } else {
        options.writeError("Database is not ready\n");
      }
    } else {
      const result = await runtime.migrate();
      successOutput = `Database migrations applied: ${result.appliedVersions.length}; current version: ${result.currentVersion}\n`;
      exitCode = 0;
    }
  } catch {
    options.writeError(`Database ${command} failed\n`);
  }

  try {
    await runtime.close();
  } catch {
    if (exitCode === 0) {
      options.writeError("Database close failed\n");
    }
    exitCode = 1;
  }

  if (exitCode === 0 && successOutput) {
    options.writeOutput(successOutput);
  }

  return exitCode;
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;

if (isDirectExecution) {
  void runDatabaseCli({
    args: process.argv.slice(2),
    createRuntime: createPostgresDatabase,
    environment: process.env,
    writeError: (message) => process.stderr.write(message),
    writeOutput: (message) => process.stdout.write(message),
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
