import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import * as databaseModule from "./index.js";

interface TestRuntime {
  check(): Promise<{
    databaseReachable: boolean;
    migrationsCurrent: boolean;
  }>;
  close(): Promise<void>;
  migrate(): Promise<{
    appliedVersions: readonly number[];
    currentVersion: number;
  }>;
}

type CliModuleContract = {
  isDirectExecution?: (
    moduleUrl: string,
    entryPath: string | undefined,
  ) => boolean;
  runDatabaseCli?: (options: {
    args: readonly string[];
    createRuntime: (databaseUrl: string) => TestRuntime;
    environment: Record<string, string | undefined>;
    writeError: (message: string) => void;
    writeOutput: (message: string) => void;
  }) => Promise<number>;
};

const cli = databaseModule as CliModuleContract;

function testRuntime(
  readiness: {
    databaseReachable: boolean;
    migrationsCurrent: boolean;
  } = { databaseReachable: true, migrationsCurrent: true },
) {
  return {
    check: vi.fn(async () => readiness),
    close: vi.fn(async () => undefined),
    migrate: vi.fn(async () => ({
      appliedVersions: [1],
      currentVersion: 1,
    })),
  };
}

function invoke(
  command: "check" | "migrate",
  runtime: TestRuntime,
  databaseUrl = "postgresql://db.example/matchsense",
) {
  const writeError = vi.fn();
  const writeOutput = vi.fn();
  const createRuntime = vi.fn(() => runtime);

  return {
    createRuntime,
    result: cli.runDatabaseCli?.({
      args: [command],
      createRuntime,
      environment: { DATABASE_URL: databaseUrl },
      writeError,
      writeOutput,
    }),
    writeError,
    writeOutput,
  };
}

describe("database CLI", () => {
  it("recognizes a symlinked argv entry and safely rejects missing paths", async () => {
    expect(cli.isDirectExecution).toBeTypeOf("function");
    const directory = await mkdtemp(path.join(os.tmpdir(), "matchsense-cli-"));
    const targetPath = path.join(directory, "cli.js");
    const symlinkPath = path.join(directory, "deployed-cli.js");

    try {
      await writeFile(targetPath, "export {};\n");
      await symlink(targetPath, symlinkPath);

      expect(
        cli.isDirectExecution?.(pathToFileURL(targetPath).href, symlinkPath),
      ).toBe(true);
      expect(
        cli.isDirectExecution?.(
          pathToFileURL(targetPath).href,
          path.join(directory, "missing.js"),
        ),
      ).toBe(false);
      expect(
        cli.isDirectExecution?.(pathToFileURL(targetPath).href, undefined),
      ).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("exits zero only when the database is reachable and current", async () => {
    expect(cli.runDatabaseCli).toBeTypeOf("function");
    const runtime = testRuntime();
    const invocation = invoke("check", runtime);

    await expect(invocation.result).resolves.toBe(0);
    expect(invocation.writeOutput).toHaveBeenCalledExactlyOnceWith(
      "Database migrations are current\n",
    );
    expect(invocation.writeError).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { databaseReachable: true, migrationsCurrent: false },
    { databaseReachable: false, migrationsCurrent: false },
  ])("exits nonzero with a generic check error for %j", async (readiness) => {
    expect(cli.runDatabaseCli).toBeTypeOf("function");
    const runtime = testRuntime(readiness);
    const invocation = invoke("check", runtime);

    await expect(invocation.result).resolves.toBe(1);
    expect(invocation.writeError).toHaveBeenCalledExactlyOnceWith(
      "Database is not ready\n",
    );
    expect(invocation.writeOutput).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("applies migrations and reports only version counts", async () => {
    expect(cli.runDatabaseCli).toBeTypeOf("function");
    const runtime = testRuntime();
    const invocation = invoke("migrate", runtime);

    await expect(invocation.result).resolves.toBe(0);
    expect(runtime.migrate).toHaveBeenCalledTimes(1);
    expect(invocation.writeOutput).toHaveBeenCalledExactlyOnceWith(
      "Database migrations applied: 1; current version: 1\n",
    );
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("redacts runtime failures and the database URL", async () => {
    expect(cli.runDatabaseCli).toBeTypeOf("function");
    const sensitiveMarker = ["private", "credential", "marker"].join("-");
    const runtime = testRuntime();
    runtime.check.mockRejectedValueOnce(new Error(sensitiveMarker));
    const invocation = invoke(
      "check",
      runtime,
      `postgresql://db.example/matchsense?marker=${sensitiveMarker}`,
    );

    await expect(invocation.result).resolves.toBe(1);
    expect(invocation.writeError).toHaveBeenCalledExactlyOnceWith(
      "Database check failed\n",
    );
    const output = invocation.writeError.mock.calls.flat().join(" ");
    expect(output).not.toContain(sensitiveMarker);
    expect(output).not.toContain("postgresql://");
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("rejects missing configuration without constructing a runtime", async () => {
    expect(cli.runDatabaseCli).toBeTypeOf("function");
    const createRuntime = vi.fn(() => testRuntime());
    const writeError = vi.fn();

    await expect(
      cli.runDatabaseCli?.({
        args: ["check"],
        createRuntime,
        environment: {},
        writeError,
        writeOutput: vi.fn(),
      }),
    ).resolves.toBe(1);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      "Database configuration is invalid\n",
    );
  });

  it("rejects a non-PostgreSQL URL without constructing a runtime", async () => {
    expect(cli.runDatabaseCli).toBeTypeOf("function");
    const createRuntime = vi.fn(() => testRuntime());
    const writeError = vi.fn();

    await expect(
      cli.runDatabaseCli?.({
        args: ["check"],
        createRuntime,
        environment: { DATABASE_URL: "https://db.example/matchsense" },
        writeError,
        writeOutput: vi.fn(),
      }),
    ).resolves.toBe(1);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      "Database configuration is invalid\n",
    );
  });

  it.each([{ args: [] }, { args: ["unknown"] }])(
    "rejects unsupported command arguments %j",
    async ({ args }) => {
      expect(cli.runDatabaseCli).toBeTypeOf("function");
      const createRuntime = vi.fn(() => testRuntime());
      const writeError = vi.fn();

      await expect(
        cli.runDatabaseCli?.({
          args,
          createRuntime,
          environment: {
            DATABASE_URL: "postgresql://db.example/matchsense",
          },
          writeError,
          writeOutput: vi.fn(),
        }),
      ).resolves.toBe(1);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(writeError).toHaveBeenCalledExactlyOnceWith(
        "Database command is invalid\n",
      );
    },
  );

  it("treats a close rejection as failure without printing prior success", async () => {
    expect(cli.runDatabaseCli).toBeTypeOf("function");
    const sensitiveMarker = ["close", "private", "marker"].join("-");
    const runtime = testRuntime();
    runtime.close.mockRejectedValueOnce(new Error(sensitiveMarker));
    const invocation = invoke("check", runtime);

    await expect(invocation.result).resolves.toBe(1);
    expect(invocation.writeOutput).not.toHaveBeenCalled();
    expect(invocation.writeError).toHaveBeenCalledExactlyOnceWith(
      "Database close failed\n",
    );
    expect(invocation.writeError.mock.calls.flat().join(" ")).not.toContain(
      sensitiveMarker,
    );
  });
});
