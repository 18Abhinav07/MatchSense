import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseServerEnv, type ServerConfig } from "./config.js";

export interface RoleRuntime {
  close(): Promise<void>;
}

type ApiModule = {
  startApi(config: ServerConfig): Promise<RoleRuntime>;
};

type CollectorModule = {
  startCollector(config: ServerConfig): Promise<RoleRuntime>;
};

export interface RoleEntrypointLoaders {
  loadApi?: () => Promise<ApiModule>;
  loadCollector?: () => Promise<CollectorModule>;
}

export interface RoleStartResult {
  apiStarted: boolean;
  collectorStarted: boolean;
  role: ServerConfig["role"];
  runtime: RoleRuntime;
}

const loadApiModule = () => import("./api-main.js");
const loadCollectorModule = () => import("./collector-main.js");

export async function startByRole(
  environment: Record<string, string | undefined> = process.env,
  loaders: RoleEntrypointLoaders = {},
): Promise<RoleStartResult> {
  const config = parseServerEnv(environment);

  if (config.role === "api") {
    const api = await (loaders.loadApi ?? loadApiModule)();
    return {
      apiStarted: true,
      collectorStarted: false,
      role: "api",
      runtime: await api.startApi(config),
    };
  }

  const collector = await (loaders.loadCollector ?? loadCollectorModule)();
  return {
    apiStarted: false,
    collectorStarted: true,
    role: "worker",
    runtime: await collector.startCollector(config),
  };
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;

if (isDirectExecution) {
  void startByRole().catch(() => {
    process.stderr.write("MatchSense service failed to start\n");
    process.exitCode = 1;
  });
}
