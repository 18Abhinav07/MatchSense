/// <reference types="node" />

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("installable PWA contract", () => {
  it("declares an installable standalone manifest", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../public/manifest.webmanifest", import.meta.url),
        "utf8",
      ),
    ) as { display?: string; icons?: unknown[]; start_url?: string };

    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons?.length).toBeGreaterThanOrEqual(2);
  });

  it("never intercepts API or continuous MP3 stream requests", async () => {
    const serviceWorker = await readFile(
      new URL("../public/sw.js", import.meta.url),
      "utf8",
    );

    expect(serviceWorker).toContain('pathname.startsWith("/api/")');
    expect(serviceWorker).toContain('pathname.endsWith("stream.mp3")');
    expect(serviceWorker).toContain("return;");
  });

  it("renders canonical Moment pushes and deep-links notification taps", async () => {
    const [serviceWorker, notificationContract] = await Promise.all([
      readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
      readFile(
        new URL("../public/push-notification.js", import.meta.url),
        "utf8",
      ),
    ]);

    expect(serviceWorker).toContain('addEventListener("push"');
    expect(serviceWorker).toContain('addEventListener("notificationclick"');
    expect(serviceWorker).toContain("showNotification");
    expect(serviceWorker).toContain("clients.openWindow");
    expect(notificationContract).toContain("momentId");
    expect(notificationContract).toContain("revision");
    expect(notificationContract).toContain("momentIdentity");
  });
});
