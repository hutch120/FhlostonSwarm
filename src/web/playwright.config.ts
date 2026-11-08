import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;

// E2E runs against the Vite dev server plus the local API (`npm run dev -w src/api`): in-memory
// data and a collected mailbox, so no AWS access or email is involved.
const API_PORT = 8787;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev",
      url: `http://localhost:${PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "npm --prefix ../.. run dev --workspace @swarm/api",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
