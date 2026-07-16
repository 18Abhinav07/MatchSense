import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildApp, type ReadinessProbe } from "./app.js";
import { parseServerEnv } from "./config.js";
import {
  createShutdownFailureReporter,
  registerShutdownSignals,
  type ShutdownSignalSource,
} from "./start.js";

const unavailableReadinessProbe: ReadinessProbe = {
  check: async () => ({
    databaseReachable: false,
    migrationsCurrent: false,
  }),
};

export interface StartServerOptions {
  environment?: Record<string, string | undefined>;
  readinessProbe?: ReadinessProbe;
  signalSource?: ShutdownSignalSource;
  webDistPath?: string;
}

export async function startServer(options: StartServerOptions = {}) {
  const config = parseServerEnv(options.environment ?? process.env);
  const webDistPath =
    options.webDistPath ?? path.resolve(import.meta.dirname, "../../web/dist");
  const app = buildApp({
    readinessProbe: options.readinessProbe ?? unavailableReadinessProbe,
    webDistPath,
  });

  await app.listen({ host: config.host, port: config.port });
  registerShutdownSignals(
    options.signalSource ?? process,
    async () => app.close(),
    createShutdownFailureReporter({
      setExitCode: (code) => {
        process.exitCode = code;
      },
      writeError: (message) => process.stderr.write(message),
    }),
  );
  return app;
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;

if (isDirectExecution) {
  void startServer().catch(() => {
    process.stderr.write("MatchSense server failed to start\n");
    process.exitCode = 1;
  });
}
