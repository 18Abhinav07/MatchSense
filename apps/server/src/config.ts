import { z } from "zod";

const serverEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATA_RIGHTS_MODE: z.literal("synthetic_demo").default("synthetic_demo"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
});

export interface ServerConfig {
  databaseUrl: string;
  dataRightsMode: "synthetic_demo";
  host: string;
  port: number;
}

export function parseServerEnv(
  environment: Record<string, string | undefined>,
): ServerConfig {
  const result = serverEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error("Invalid MatchSense server configuration");
  }

  return {
    databaseUrl: result.data.DATABASE_URL,
    dataRightsMode: result.data.DATA_RIGHTS_MODE,
    host: result.data.HOST,
    port: result.data.PORT,
  };
}
