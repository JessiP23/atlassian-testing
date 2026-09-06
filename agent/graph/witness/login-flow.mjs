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
// The signed-out area. Sign-in is two PAGES here — /login takes the email (and looks up SSO), then
// navigates to /signin for the password; /saiu is the SSO return, /user-mfa the MFA prompt. A wait
// for "no longer on /login" is satisfied the moment /signin appears, BEFORE Cognito has answered —
// that race is what produced "signed in" with an empty state, twice.
const SIGNED_OUT = /^\/(login|signin|saiu|user-mfa)(\/|$)/

export async function doLogin(page, { email, password }, onProgress = () => {}) {
  onProgress('opening /login')
  await page.goto('/login')
  // Either the email box shows up (signed out) or the app itself redirects away (already in).
  // No networkidle wait: this app polls after load, so "idle" can take the whole timeout to arrive.
  const emailBox = page.locator('#email').or(page.getByRole('textbox').first()).first()
  await Promise.race([
    emailBox.waitFor({ state: 'visible', timeout: 90_000 }),
    page.waitForURL((u) => !SIGNED_OUT.test(u.pathname), { timeout: 90_000 }),
  ])
  if (!SIGNED_OUT.test(new URL(page.url()).pathname)) { onProgress('already signed in'); return false }

  onProgress('entering the email')
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
  onProgress(`on ${new URL(page.url()).pathname} — entering the password`)
  await passwordBox.first().fill(password)
  await page.getByRole('button', { name: /^\s*(log ?in|sign ?in|continue|submit)\s*$/i }).first().click()
  onProgress('submitted — waiting for the app to leave the sign-in pages (up to 60s)')
  await page.waitForURL((u) => !SIGNED_OUT.test(u.pathname), { timeout: 60_000 })
  onProgress(`landed on ${new URL(page.url()).pathname} — waiting for the session cookie`)
  // Cognito writes its cookies a beat after the redirect; give them a moment before anyone snapshots.
  await page.waitForFunction(() => /CognitoIdentityServiceProvider/.test(document.cookie), null, { timeout: 15_000 }).catch(() => {})
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
