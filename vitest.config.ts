import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: "node",
          include: ["src/**/*.test.ts", "utils/**/*.test.ts"],
          exclude: ["**/node_modules/**", "src/web/**"],
        },
      },
      {
        // The web app reuses its Vite config (React plugin) and runs under jsdom.
        extends: "./src/web/vite.config.ts",
        test: {
          name: "web",
          include: ["src/web/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["./src/web/src/test/setup.ts"],
        },
      },
    ],
  },
});
