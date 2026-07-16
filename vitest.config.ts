import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/*.integration.test.{ts,tsx}", "**/node_modules/**"],
    include: ["{apps,packages}/**/*.test.{ts,tsx}"],
  },
});
