/**
 * The app's sign-in, as plain page steps — no test runner, no fixtures.
 *
 * Shared by `bin/login-state.mjs`, which drives it once with a bare Chromium to bake a storageState
 * file. That file is what the QA browser loads, so the model starts SIGNED IN: it never writes a
 * login, never spends its budget on the one leg identical for every ticket, and the password never
 * enters its transcript.
 */
export function credentials() {
  const bad = (v) => !v || /[<>]/.test(String(v)) || /^(your|todo|changeme)/i.test(String(v))
  const email = process.env.PAG_APP_EMAIL
  const password = process.env.PAG_APP_PASSWORD
  if (bad(email) || bad(password)) return null
  return { email, password }
}

/**
 * ONE-STEP OR TWO-STEP. This app is two-step — email, Continue, then a password box with no
 * `#password` id and a "Log in" button. Waits for "no longer on /login" rather than a named landing
 * route: the app chooses where to send you.
 *
 * "Already signed in" is decided by the URL, never by a timeout. The first version guessed "no email
 * box after 5s, must be in" — the dev server was still compiling the /login route, so it baked an
 * EMPTY state, printed "signed in", and every QA browser afterwards opened on the login page.
 */
export async function doLogin(page, { email, password }) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
  if (!/\/login/.test(new URL(page.url()).pathname)) return false // the app itself left /login: already in

  const emailBox = page.locator('#email').or(page.getByRole('textbox').first()).first()
  await emailBox.waitFor({ state: 'visible', timeout: 90_000 })
  await emailBox.fill(email)

  // Step two only exists in the two-step flow. When a password box is already on screen this is a
  // one-step form and Continue IS the submit button, so do not click it twice.
  if (!(await page.locator('#password').isVisible({ timeout: 1_000 }).catch(() => false))) {
    const next = page.getByRole('button', { name: /^\s*(continue|next)\s*$/i }).first()
    if (await next.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await next.click()
      await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    }
  }

  const passwordBox = page.locator('#password')
    .or(page.getByLabel(/password/i))
    .or(page.locator('input[type="password"]'))
  await passwordBox.first().fill(password)
  await page.getByRole('button', { name: /^\s*(log ?in|sign ?in|continue|submit)\s*$/i }).first().click()
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 60_000 })
  return true
}

/**
 * Does a Playwright storageState actually hold a session? This app keeps Cognito tokens in cookies
 * (`CognitoIdentityServiceProvider.*`) and the API bearer token in Amplify Cache (localStorage
 * `aws-amplify-cache…authToken`). Leaving /login proves nothing on its own.
 */
export function signedIn(state) {
  const cookies = (state.cookies || []).some((c) => /Cognito|idToken|accessToken|session/i.test(c.name))
  const local = (state.origins || []).some((o) => (o.localStorage || []).some((e) => /authToken|idToken|accessToken/i.test(e.name)))
  return cookies || local
}
