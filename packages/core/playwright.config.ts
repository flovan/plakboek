import { defineConfig, devices } from '@playwright/test';

const VIEWPORT = { width: 1400, height: 900 };

/**
 * Real-browser suite for the edit shell and the adversarial host theme.
 * One worker, because every spec shares the database global setup seeds.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    // Global setup exports it; every worker loads this file after that.
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: VIEWPORT },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: VIEWPORT },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: VIEWPORT },
    },
  ],
});
