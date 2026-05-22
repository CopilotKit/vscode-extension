import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environmentMatchGlobs: [
      ["src/webview/**", "jsdom"],
      ["src/extension/**", "node"],
    ],
    server: {
      deps: {
        inline: [/@copilotkit/],
      },
    },
    setupFiles: ["./vitest.setup.ts"],
  },
});
