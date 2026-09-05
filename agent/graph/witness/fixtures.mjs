import { credentials, doLogin } from './login-flow.mjs'
// Shared helpers for generated witness specs. Imported by the spec the reproduce node writes.
//
// login(): the Pioneer login form (containers/Login/LoginForm.tsx) — #email, #password, submit.
// Credentials come from the environment the worker injects; a spec never reads a .env file.
// Third-party beacons are blocked so screenshots are stable and runs are faster; the app's own
// backend is never blocked.
import { test as base, expect } from '@playwright/test'

const BLOCK = /(googletagmanager|google-analytics|segment\.io|segment\.com|hotjar|fullstory|intercom|sentry\.io|datadoghq|mixpanel)\./

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(/.*/, (route) => (BLOCK.test(route.request().url()) ? route.abort() : route.continue()))
    await use(page)
  },
})

export { expect }
export { credentials } from './login-flow.mjs'

/** Log in with the QA user. Idempotent; the flow itself lives in login-flow.mjs, shared with
 * bin/login-state.mjs so the authoring browser and the spec sign in exactly the same way. */
export async function login(page) {
  const creds = credentials()
  if (!creds) throw new Error('PAG_APP_EMAIL / PAG_APP_PASSWORD are not set to a real account — this spec must only use pages that need no login')
  await doLogin(page, creds)
}

/**
 * A named, numbered screenshot: shot(page, '02-after-toggle-dark').
 *
 * The NAME is the contract. The same spec runs twice — once before the fix, once after — and the
 * PR pairs the two runs BY NAME, so `02-...` from the red run sits beside `02-...` from the green
 * run. Name the STATE, not just the step.
 */
export async function shot(page, name) {
  const info = test.info()
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled' })
  return file
}

/**
 * A SOFT assertion plus a screenshot of the state it judged.
 *
 * Why soft: a hard `expect` throws, so the red run dies at the first unmet criterion and the only
 * evidence is one frame of a flow nobody got to see. With soft assertions the spec walks the WHOLE
 * flow, captures every state, and still fails at the end if any check failed — Playwright fails a
 * test with failed soft assertions, so nothing is weakened.
 *
 *   await check(page, '02-after-toggle-dark', async () => {
 *     await expect.soft(page.locator('html')).toHaveClass(/dark/)
 *     await expect.soft(page.locator('body')).toHaveCSS('background-color', 'rgb(10, 10, 10)')
 *   })
 */
export async function check(page, name, assertions) {
  try {
    await assertions()
  } catch (err) {
    // A locator that does not exist yet throws even under expect.soft: record it and keep walking.
    test.info().errors.push({ message: `[${name}] ${err?.message || err}` })
  }
  await shot(page, name)
}
