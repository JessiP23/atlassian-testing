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
import { credentials, doLogin } from '../witness/login-flow.mjs'
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
try {
  await doLogin(page, creds)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await context.storageState({ path: out })
  console.log(`signed in as ${creds.email} — state written to ${out}`)
} catch (e) {
  console.error(`could not sign in at ${url}: ${String(e.message).split('\n')[0]}`)
  process.exitCode = 1
} finally {
  await browser.close()
  if (started) stopApp()
}
