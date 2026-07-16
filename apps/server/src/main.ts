import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createPostgresDatabase } from "@matchsense/db";

import { buildApp, type ReadinessProbe } from "./app.js";
import { parseServerEnv } from "./config.js";
import {
  createProductRuntime,
  type ProductRuntime,
} from "./product-runtime.js";
import {
  createShutdownFailureReporter,
  registerShutdownSignals,
  type ShutdownSignalSource,
} from "./start.js";

interface ServerDatabaseRuntime extends ReadinessProbe {
  close(): Promise<void>;
}

export interface StartServerOptions {
  databaseFactory?: (databaseUrl: string) => ServerDatabaseRuntime;
  databaseRuntime?: ServerDatabaseRuntime;
  environment?: Record<string, string | undefined>;
  listen?: boolean;
  readinessProbe?: ReadinessProbe;
  productRuntime?: ProductRuntime;
  signalSource?: ShutdownSignalSource;
  webDistPath?: string;
}

export async function startServer(options: StartServerOptions = {}) {
  const config = parseServerEnv(options.environment ?? process.env);
  const webDistPath =
    options.webDistPath ?? path.resolve(import.meta.dirname, "../../web/dist");
  const databaseRuntime =
    options.databaseRuntime ??
    (options.readinessProbe
      ? undefined
      : (options.databaseFactory ?? createPostgresDatabase)(
          config.databaseUrl,
        ));
  const productRuntime =
    options.productRuntime ??
    createProductRuntime({
      cueBytes: await readFile(
        path.resolve(import.meta.dirname, "../assets/goal-cue.mp3"),
      ),
      silenceBytes: await readFile(
        path.resolve(import.meta.dirname, "../assets/silence.mp3"),
      ),
      writeIntervalMs: 940,
    });
  const app = buildApp({
    readinessProbe: options.readinessProbe ?? databaseRuntime!,
    runtime: productRuntime,
    webDistPath,
  });

  let unregisterSignals: () => void = () => undefined;
  app.addHook("onClose", async () => {
    unregisterSignals();
    productRuntime.close();
    await databaseRuntime?.close();
  });

  try {
    if (options.listen !== false) {
      await app.listen({ host: config.host, port: config.port });
    }
  } catch (error) {
    await app.close();
    throw error;
  }

  unregisterSignals = registerShutdownSignals(
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
