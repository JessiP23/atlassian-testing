#!/usr/bin/env node
// Bake a signed-in browser state for the AUTHORING browser.
//
// The witness's model used to spend 60-90s of a 210s budget rediscovering and re-implementing this
// app's two-step sign-in, on every ticket. It now starts signed in: this drives the same verified
// flow once with a bare Chromium and writes the cookies/localStorage to a storageState file that
// @playwright/mcp loads with --storage-state. The password never enters the model's transcript.
//
//   node bin/login-state.mjs [--url http://localhost:3000] [--out .pag/login-state.json]
import '../src/lib/boot.mjs'   // loads graph/.env before anything reads process.env
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright'
import { credentials, doLogin, signedIn } from '../witness/login-flow.mjs'
import { ensureApp, stopApp } from '../src/lib/app.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
let url = arg('url', process.env.PAG_APP_URL || 'http://localhost:3000')
const out = path.resolve(arg('out', path.join(path.dirname(import.meta.dirname), '.pag', 'login-state.json')))
const repo = arg('repo', process.env.PAG_WORKTREE || path.join(os.homedir(), 'pioneer-agent'))

const creds = credentials()
if (!creds) { console.error('PAG_APP_EMAIL / PAG_APP_PASSWORD are not set to a real account'); process.exit(2) }

// Start the app if it is not already answering. Asking the operator to run a dev server in another
// terminal first is a step that can be forgotten, and was — `npm run login` is one command or it is
// not worth having. A server already on the port is reused and left running.
let started = false
const answering = await fetch(url, { signal: AbortSignal.timeout(3_000) }).then(() => true).catch(() => false)
if (!answering) {
  console.log(`  ${url} is not answering — starting the app from ${repo}`)
  const app = await ensureApp({ repo, onProgress: (l) => console.log(`  ${l}`) })
  if (!app) { console.error(`could not start the app from ${repo} — is that the right worktree?`); process.exit(1) }
  url = app.url
  started = true
}

const browser = await chromium.launch()
const context = await browser.newContext({ baseURL: url, viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
// Print Cognito's own answer. The app swallows sign-in errors into store state and shows nothing, so
// a wrong password, a user missing from THIS pool, or an MFA challenge all look like "nothing happened".
page.on('response', async (r) => {
  if (!/cognito-idp\./.test(r.url())) return
  const target = (r.request().headers()['x-amz-target'] || '').replace('AWSCognitoIdentityProviderService.', '')
  const clientId = /"ClientId":"([^"]+)"/.exec(r.request().postData() || '')?.[1] || '?'
  if (r.status() >= 400) {
    const body = await r.text().catch(() => '')
    console.error(`  cognito ${target} (client ${clientId}) → ${r.status()} ${body.slice(0, 240)}`)
  } else if (target === 'InitiateAuth' || target === 'RespondToAuthChallenge') {
    const body = await r.text().catch(() => '')
    const challenge = /"ChallengeName":"([^"]+)"/.exec(body)?.[1]
    console.log(`  cognito ${target} (client ${clientId}) → ${r.status()}${challenge ? ' challenge ' + challenge : ' tokens issued'}`)
  }
})
try {
  await doLogin(page, creds, (l) => console.log(`  ${l}`))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const state = await context.storageState()
  // Leaving /login is not a session. Refuse to write a state with no token in it — an empty state
  // is worse than none, because the QA node then trusts it and the browser opens on the login page.
  if (!signedIn(state)) {
    const shot = out.replace(/\.json$/, '-failed.png')
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
    fs.rmSync(out, { force: true })
    throw new Error(`landed on ${page.url()} with no session cookie or token — wrong password, wrong Cognito pool for this backend, or the form changed (see ${shot})`)
  }
  fs.writeFileSync(out, JSON.stringify(state, null, 2), { mode: 0o600 })
  console.log(`signed in as ${creds.email} — state written to ${out}`)
} catch (e) {
  console.error(`could not sign in at ${url}: ${String(e.message).split('\n')[0]}`)
  // Show what the sign-in page was saying when we gave up: the error under the field, a
  // new-password form, an MFA code box. Guessing between those from a timeout wasted two runs.
  const shot = out.replace(/\.json$/, '-failed.png')
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    await page.screenshot({ path: shot, fullPage: true })
    const said = await page.evaluate(() => {
      const t = (el) => (el?.innerText || '').trim()
      const alerts = [...document.querySelectorAll('[role=alert], .error, [class*=error], [class*=Error]')].map(t).filter(Boolean)
      const inputs = [...document.querySelectorAll('input')].map((i) => `${i.type}${i.name ? ':' + i.name : ''}${i.placeholder ? ' "' + i.placeholder + '"' : ''}`)
      return { path: location.pathname, alerts: [...new Set(alerts)].slice(0, 5), inputs }
    })
    console.error(`  page: ${said.path}`)
    if (said.alerts.length) console.error(`  page says: ${said.alerts.join(' | ')}`)
    console.error(`  inputs on the page: ${said.inputs.join(', ') || 'none'}`)
    console.error(`  screenshot: ${shot}`)
  } catch {}
  process.exitCode = 1
} finally {
  await browser.close()
  if (started) stopApp()
}
