import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@matchsense/commentary": path.join(
        root,
        "packages/commentary/src/index.ts",
      ),
      "@matchsense/contracts": path.join(
        root,
        "packages/contracts/src/index.ts",
      ),
      "@matchsense/event-engine": path.join(
        root,
        "packages/event-engine/src/index.ts",
      ),
      "@matchsense/replay": path.join(root, "packages/replay/src/index.ts"),
      "@matchsense/rooms": path.join(root, "packages/rooms/src/index.ts"),
      "@matchsense/txline-adapter": path.join(
        root,
        "packages/txline-adapter/src/index.ts",
      ),
    },
  },
  test: {
    exclude: ["**/*.integration.test.{ts,tsx}", "**/node_modules/**"],
    include: ["{apps,packages}/**/*.test.{ts,tsx}"],
  },
});
