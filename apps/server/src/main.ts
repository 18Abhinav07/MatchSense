import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createCommentaryPipeline } from "@matchsense/commentary";
import { createPostgresDatabase } from "@matchsense/db";
import { createTxlineLiveScoreSource } from "@matchsense/txline-adapter";

import { buildApp, type ReadinessProbe } from "./app.js";
import { transcodeWavToStreamMp3 } from "./audio-transcoder.js";
import { parseServerEnv } from "./config.js";
import { inspectMp3 } from "./mp3.js";
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

const VERIFIED_HACKATHON_FIXTURE = {
  fixtureId: "18237038",
  participant1: { id: "1999", name: "France" },
  participant1IsHome: true,
  participant2: { id: "3021", name: "Spain" },
} as const;

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
  let productRuntime = options.productRuntime;
  if (!productRuntime) {
    const cueBytes = await readFile(
      path.resolve(import.meta.dirname, "../assets/goal-cue.mp3"),
    );
    const streamContract = inspectMp3(cueBytes);
    productRuntime = createProductRuntime({
      commentaryPipeline: createCommentaryPipeline({
        env: options.environment ?? process.env,
      }),
      cueBytes,
      ...(config.dataRightsMode === "txline_hackathon"
        ? {
            fixture: {
              awayTeam: "ESP" as const,
              fixtureId: VERIFIED_HACKATHON_FIXTURE.fixtureId,
              homeTeam: "FRA" as const,
              kickoffAt: "2026-07-14T15:00:00.000Z",
              participant1IsHome: true,
              provenance: "live_txline" as const,
            },
          }
        : {}),
      silenceBytes: await readFile(
        path.resolve(import.meta.dirname, "../assets/silence.mp3"),
      ),
      transcodeCommentary: (wavBytes) =>
        transcodeWavToStreamMp3(wavBytes, { expected: streamContract }),
      writeIntervalMs: 940,
    });
  }
  let txlineAbort: AbortController | null = null;
  let txlineTask: Promise<void> | null = null;
  if (config.dataRightsMode === "txline_hackathon") {
    txlineAbort = new AbortController();
    const source = createTxlineLiveScoreSource({
      apiToken: config.txlineApiToken!,
      fixtures: [VERIFIED_HACKATHON_FIXTURE],
      onEvent: (event) => {
        productRuntime.acceptTxlineEvent(event);
      },
    });
    txlineTask = source.run(txlineAbort.signal).catch(() => undefined);
  }
  const app = buildApp({
    readinessProbe: options.readinessProbe ?? databaseRuntime!,
    runtime: productRuntime,
    webDistPath,
  });

  let unregisterSignals: () => void = () => undefined;
  app.addHook("onClose", async () => {
    unregisterSignals();
    txlineAbort?.abort();
    await txlineTask;
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
