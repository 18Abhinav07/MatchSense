import { z } from "zod";

function hasPostgreSqlProtocol(value: string) {
  if (!URL.canParse(value)) {
    return false;
  }

  return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
}

const serverEnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().url().refine(hasPostgreSqlProtocol),
    DATA_RIGHTS_MODE: z
      .enum(["synthetic_demo", "txline_hackathon"])
      .default("synthetic_demo"),
    HOST: z.string().trim().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    TXLINE_API_TOKEN: z.string().trim().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().trim().min(1).optional(),
    VAPID_PUBLIC_KEY: z.string().trim().min(1).optional(),
    VAPID_SUBJECT: z.string().trim().min(1).optional(),
  })
  .superRefine((environment, context) => {
    if (
      environment.DATA_RIGHTS_MODE === "txline_hackathon" &&
      !environment.TXLINE_API_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        message: "TxLINE token is required for hackathon source mode",
        path: ["TXLINE_API_TOKEN"],
      });
    }
    const vapidValues = [
      environment.VAPID_PRIVATE_KEY,
      environment.VAPID_PUBLIC_KEY,
      environment.VAPID_SUBJECT,
    ];
    if (vapidValues.some(Boolean) && !vapidValues.every(Boolean)) {
      context.addIssue({
        code: "custom",
        message: "VAPID configuration must include subject and both keys",
        path: ["VAPID_PUBLIC_KEY"],
      });
    }
  });

export interface ServerConfig {
  databaseUrl: string;
  dataRightsMode: "synthetic_demo" | "txline_hackathon";
  host: string;
  port: number;
  txlineApiToken?: string;
  vapid?: { privateKey: string; publicKey: string; subject: string };
}

export function parseServerEnv(
  environment: Record<string, string | undefined>,
): ServerConfig {
  const result = serverEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error("Invalid MatchSense server configuration");
  }

  const config: ServerConfig = {
    databaseUrl: result.data.DATABASE_URL,
    dataRightsMode: result.data.DATA_RIGHTS_MODE,
    host: result.data.HOST,
    port: result.data.PORT,
  };
  if (result.data.DATA_RIGHTS_MODE === "txline_hackathon") {
    config.txlineApiToken = result.data.TXLINE_API_TOKEN!;
  }
  if (
    result.data.VAPID_PRIVATE_KEY &&
    result.data.VAPID_PUBLIC_KEY &&
    result.data.VAPID_SUBJECT
  ) {
    config.vapid = {
      privateKey: result.data.VAPID_PRIVATE_KEY,
      publicKey: result.data.VAPID_PUBLIC_KEY,
      subject: result.data.VAPID_SUBJECT,
    };
  }
  return config;
}
