import { z } from "zod";

export type ServerRole = "api" | "worker";
export type DataRightsMode = "synthetic_demo" | "txline_hackathon";

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
      .default("txline_hackathon"),
    HOST: z.string().trim().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    PUSH_SUBSCRIPTION_ENCRYPTION_SECRET: z.string().trim().min(16).optional(),
    ROLE: z.enum(["api", "worker"]).default("worker"),
    TXLINE_API_TOKEN: z.string().trim().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().trim().min(1).optional(),
    VAPID_PUBLIC_KEY: z.string().trim().min(1).optional(),
    VAPID_SUBJECT: z.string().trim().min(1).optional(),
  })
  .superRefine((environment, context) => {
    if (
      environment.ROLE === "worker" &&
      environment.DATA_RIGHTS_MODE === "txline_hackathon" &&
      !environment.TXLINE_API_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        message: "TxLINE token is required",
        path: ["TXLINE_API_TOKEN"],
      });
    }
    if (environment.ROLE === "api" && environment.TXLINE_API_TOKEN) {
      context.addIssue({
        code: "custom",
        message: "API role must not receive TxLINE token",
        path: ["TXLINE_API_TOKEN"],
      });
    }
    if (
      environment.ROLE === "api" &&
      environment.DATA_RIGHTS_MODE === "synthetic_demo"
    ) {
      context.addIssue({
        code: "custom",
        message: "API role cannot run synthetic demo data",
        path: ["DATA_RIGHTS_MODE"],
      });
    }
    if (environment.ROLE === "api" && environment.VAPID_PRIVATE_KEY) {
      context.addIssue({
        code: "custom",
        message: "API role must not receive VAPID private key",
        path: ["VAPID_PRIVATE_KEY"],
      });
    }
    const vapidValues = [
      environment.VAPID_PRIVATE_KEY,
      environment.VAPID_PUBLIC_KEY,
      environment.VAPID_SUBJECT,
    ];
    if (
      environment.ROLE === "worker" &&
      vapidValues.some(Boolean) &&
      !vapidValues.every(Boolean)
    ) {
      context.addIssue({
        code: "custom",
        message: "VAPID configuration must include subject and both keys",
        path: ["VAPID_PUBLIC_KEY"],
      });
    }
    if (
      environment.ROLE === "worker" &&
      vapidValues.every(Boolean) &&
      !environment.PUSH_SUBSCRIPTION_ENCRYPTION_SECRET
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Push subscription encryption secret is required for VAPID delivery",
        path: ["PUSH_SUBSCRIPTION_ENCRYPTION_SECRET"],
      });
    }
    if (environment.ROLE === "api") {
      const apiPushValues = [
        environment.VAPID_PUBLIC_KEY,
        environment.PUSH_SUBSCRIPTION_ENCRYPTION_SECRET,
      ];
      if (apiPushValues.some(Boolean) && !apiPushValues.every(Boolean)) {
        context.addIssue({
          code: "custom",
          message:
            "API push registration requires VAPID public key and subscription encryption secret",
          path: ["VAPID_PUBLIC_KEY"],
        });
      }
      if (environment.VAPID_SUBJECT) {
        context.addIssue({
          code: "custom",
          message: "API role must not receive VAPID subject",
          path: ["VAPID_SUBJECT"],
        });
      }
    }
  });

export interface ServerConfig {
  databaseUrl: string;
  dataRightsMode: DataRightsMode;
  host: string;
  port: number;
  pushSubscriptionEncryptionSecret?: string;
  role: ServerRole;
  txlineApiToken?: string;
  vapidPublicKey?: string;
  vapid?: { privateKey: string; publicKey: string; subject: string };
}

export function parseServerEnv(
  environment: Record<string, string | undefined>,
): ServerConfig {
  const result = serverEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    const customMessages = result.error.issues
      .filter((issue) => issue.code === "custom")
      .map((issue) => issue.message);
    throw new Error(
      customMessages.length > 0
        ? `Invalid MatchSense server configuration: ${customMessages.join(", ")}`
        : "Invalid MatchSense server configuration",
    );
  }

  const config: ServerConfig = {
    databaseUrl: result.data.DATABASE_URL,
    dataRightsMode: result.data.DATA_RIGHTS_MODE,
    host: result.data.HOST,
    port: result.data.PORT,
    role: result.data.ROLE,
  };
  if (
    result.data.ROLE === "worker" &&
    result.data.DATA_RIGHTS_MODE === "txline_hackathon"
  ) {
    config.txlineApiToken = result.data.TXLINE_API_TOKEN!;
  }
  if (result.data.PUSH_SUBSCRIPTION_ENCRYPTION_SECRET) {
    config.pushSubscriptionEncryptionSecret =
      result.data.PUSH_SUBSCRIPTION_ENCRYPTION_SECRET;
  }
  if (result.data.VAPID_PUBLIC_KEY) {
    config.vapidPublicKey = result.data.VAPID_PUBLIC_KEY;
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
