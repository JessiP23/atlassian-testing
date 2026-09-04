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

/** Log in with the QA user. Idempotent: returns immediately if a session already exists. */
export async function login(page, { email = process.env.PAG_APP_EMAIL, password = process.env.PAG_APP_PASSWORD } = {}) {
  if (!email || !password) throw new Error('PAG_APP_EMAIL / PAG_APP_PASSWORD are not set — the witness cannot log in')
  await page.goto('/login')
  if (!(await page.locator('#password').isVisible({ timeout: 5_000 }).catch(() => false))) return // already in
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: /log ?in|sign ?in|continue/i }).first().click()
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30_000 })
}

/** A named, numbered screenshot in the pass's output dir: shot(page, '02-after-submit'). */
export async function shot(page, name) {
  const info = test.info()
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled' })
  return file
}
