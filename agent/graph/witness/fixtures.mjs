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

/**
 * Log in with the QA user. Idempotent: returns immediately if a session already exists.
 *
 * ONE-STEP OR TWO-STEP. This app is two-step — email, Continue, then a password box with no
 * `#password` id and a "Log in" button. The old one-step version looked for `#password` on the
 * first screen, did not find it, and returned as if already signed in; every witness run then
 * rediscovered the real flow and hand-wrote its own `loginTwoStep`, which is 60-90s of a 210s
 * budget spent on the one part of the journey that is identical for every ticket.
 *
 * Waits for "no longer on /login" rather than a named landing route: the app chooses where to send
 * you, and ESI2-3406's witness died on `waitForURL(/\/home/)` for exactly that reason.
 */
export async function login(page, { email = process.env.PAG_APP_EMAIL, password = process.env.PAG_APP_PASSWORD } = {}) {
  const bad = (v) => !v || /[<>]/.test(String(v)) || /^(your|todo|changeme)/i.test(String(v))
  if (bad(email) || bad(password)) {
    throw new Error('PAG_APP_EMAIL / PAG_APP_PASSWORD are not set to a real account — this spec must only use pages that need no login')
  }
  await page.goto('/login')
  const emailBox = page.locator('#email').or(page.getByRole('textbox').first())
  if (!(await emailBox.isVisible({ timeout: 5_000 }).catch(() => false))) return  // already signed in

  await emailBox.fill(email)

  // Step two only exists in the two-step flow. When a password box is already on screen this is a
  // one-step form and Continue is the submit button, so do not click it twice.
  const passwordNow = page.locator('#password')
  if (!(await passwordNow.isVisible({ timeout: 1_000 }).catch(() => false))) {
    const next = page.getByRole('button', { name: /^\s*(continue|next)\s*$/i }).first()
    if (await next.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await next.click()
      await page.getByRole('button', { name: /^\s*(log ?in|sign ?in|submit)\s*$/i }).first()
        .waitFor({ state: 'visible', timeout: 20_000 })
    }
  }

  const passwordBox = page.locator('#password')
    .or(page.getByLabel(/password/i))
    .or(page.locator('input[type="password"]'))
    .or(page.getByRole('textbox').first())
  await passwordBox.first().fill(password)
  await page.getByRole('button', { name: /^\s*(log ?in|sign ?in|continue|submit)\s*$/i }).first().click()

  // The app decides the landing route. Assert only that we LEFT /login.
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30_000 })
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
