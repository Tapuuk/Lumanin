import { defineConfig } from '@playwright/test'

/**
 * Playwright drives the real Electron window, for the few flows that need one.
 * It is separate from Vitest on purpose —
 * these tests boot an actual daemon and cost seconds, where the unit suite costs
 * a second in total and is what runs on every save.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // The daemon takes a single-instance lock and a control socket, so two specs
  // launching at once would fight over both.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']]
})
