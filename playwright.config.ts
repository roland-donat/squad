import { defineConfig, devices } from "@playwright/test";

const port = 7301;
// Out of the repository, and wiped at every run so the walk-through always
// starts from an empty squad.
const dataDir = "/tmp/squad-browser-test";

/**
 * A single walk-through, on the nominal path: it proves the interface is wired
 * to the API and to the event stream. Everything else is covered at the seam.
 */
export default defineConfig({
  testDir: "tests/browser",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -rf ${dataDir} && SQUAD_DATA_DIR=${dataDir} SQUAD_PORT=${port} pnpm exec tsx src/server/main.ts`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
