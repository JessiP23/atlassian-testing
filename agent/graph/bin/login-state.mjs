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
import { chromium } from 'playwright'
import { credentials, doLogin } from '../witness/login-flow.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const url = arg('url', process.env.PAG_APP_URL || 'http://localhost:3000')
const out = path.resolve(arg('out', path.join(path.dirname(import.meta.dirname), '.pag', 'login-state.json')))

const creds = credentials()
if (!creds) { console.error('PAG_APP_EMAIL / PAG_APP_PASSWORD are not set to a real account'); process.exit(2) }

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
}
