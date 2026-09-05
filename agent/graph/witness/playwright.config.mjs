// Playwright config for the WITNESS rung: one generated spec, run twice (red on the pinned commit,
// green on the patched tree), recording everything. Nothing here is per-ticket — the spec file and
// the output directory arrive through env so the same config serves every run.
//
//   PAG_WITNESS_DIR   directory holding the generated spec (runs/<KEY>/<runId>/evidence/witness)
//   PAG_WITNESS_OUT   where Playwright writes screenshots / video / trace for THIS pass
//   PAG_APP_URL       the running app (default http://localhost:3000)
import { defineConfig } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

// NEVER default the output directory inside the repo. `./pw-out` here resolved to
// agent/graph/witness/pw-out, which is not gitignored, so when the patch step ran the spec by hand
// its screenshots showed up as untracked files under agent/ — a DENIED path — and a run that had
// already written a correct fix was refused at the last step. Output belongs in the run folder
// (passed as PAG_WITNESS_OUT) or in the OS temp dir, never in the working tree.
const FALLBACK_OUT = path.join(os.tmpdir(), 'pag-witness-out')

export default defineConfig({
  testDir: process.env.PAG_WITNESS_DIR || '.',
  outputDir: process.env.PAG_WITNESS_OUT || FALLBACK_OUT,
  testMatch: /.*\.spec\.mjs$/,
  timeout: 90_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: path.join(process.env.PAG_WITNESS_OUT || FALLBACK_OUT, 'report.json') }]],
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
  // PAG_HEADED=1 opens a real browser window so the run can be watched while it happens. Off by
  // default: a headed run needs a display, and CI has none.
  projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: process.env.PAG_HEADED !== '1' } }],
})
