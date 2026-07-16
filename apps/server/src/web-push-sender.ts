import webPush from "web-push";

import type { WebPushSender } from "./push-delivery.js";

export function createVapidWebPushSender(options: {
  privateKey: string;
  publicKey: string;
  subject: string;
}): WebPushSender {
  webPush.setVapidDetails(
    options.subject,
    options.publicKey,
    options.privateKey,
  );

  return {
    async send(subscription, payload) {
      const response = await webPush.sendNotification(subscription, payload, {
        TTL: 90,
        urgency: "high",
      });
      return {
        accepted: response.statusCode >= 200 && response.statusCode < 300,
      };
    },
  };
}
