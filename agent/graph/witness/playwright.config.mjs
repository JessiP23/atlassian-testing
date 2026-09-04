// Playwright config for the WITNESS rung: one generated spec, run twice (red on the pinned commit,
// green on the patched tree), recording everything. Nothing here is per-ticket — the spec file and
// the output directory arrive through env so the same config serves every run.
//
//   PAG_WITNESS_DIR   directory holding the generated spec (runs/<KEY>/<runId>/evidence/witness)
//   PAG_WITNESS_OUT   where Playwright writes screenshots / video / trace for THIS pass
//   PAG_APP_URL       the running app (default http://localhost:3000)
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: process.env.PAG_WITNESS_DIR || '.',
  outputDir: process.env.PAG_WITNESS_OUT || './pw-out',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 90_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: (process.env.PAG_WITNESS_OUT || './pw-out') + '/report.json' }]],
  use: {
    baseURL: process.env.PAG_APP_URL || 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
    screenshot: 'on',
    video: { mode: 'on', size: { width: 1280, height: 800 } },
    trace: 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
