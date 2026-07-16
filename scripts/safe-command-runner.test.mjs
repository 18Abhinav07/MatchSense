import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { runLabeledCommand } from "./safe-command-runner.mjs";

test("returns trimmed stdout for a successful labeled command", async () => {
  const output = await runLabeledCommand(
    "read deployment state",
    process.execPath,
    ["-e", 'process.stdout.write("  ready  \\n")'],
  );

  assert.equal(output, "ready");
});

test("reports a safe stage and useful stderr without leaking credentials or argv", async () => {
  const password = "sentinel-db-password";
  const databaseUrl = `postgresql://matchsense:${password}@postgres:5432/matchsense_container_test`;
  const argvSecret = "sentinel-argv-only-secret";

  await assert.rejects(
    runLabeledCommand(
      "apply database migrations",
      process.execPath,
      [
        "-e",
        `process.stderr.write(${JSON.stringify(
          [
            "migration refused by PostgreSQL",
            `DATABASE_URL=${databaseUrl}`,
            `password=${password}`,
          ].join("\n"),
        )}); process.exit(23)`,
        argvSecret,
      ],
      { sensitiveValues: [databaseUrl, password] },
    ),
    (error) => {
      assert.match(
        error.message,
        /^\[apply database migrations\] exited with code 23/u,
      );
      assert.match(error.message, /migration refused by PostgreSQL/u);
      assert.match(error.message, /DATABASE_URL=\[REDACTED\]/u);
      assert.match(error.message, /password=\[REDACTED\]/u);
      assert.doesNotMatch(error.message, /sentinel-db-password/u);
      assert.doesNotMatch(error.message, /postgresql:\/\//u);
      assert.doesNotMatch(error.message, /sentinel-argv-only-secret/u);
      return true;
    },
  );
});

test("labels a command that cannot start without exposing its argv", async () => {
  const argvSecret = "sentinel-unstarted-argv-secret";

  await assert.rejects(
    runLabeledCommand("inspect runtime", "/definitely/missing/command", [
      argvSecret,
    ]),
    (error) => {
      assert.equal(error.message, "[inspect runtime] failed to start");
      assert.doesNotMatch(error.message, /sentinel-unstarted-argv-secret/u);
      return true;
    },
  );
});
