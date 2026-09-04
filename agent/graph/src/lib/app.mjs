// The running app for the witness rung. One Vite dev server per PROCESS, started on first use and
// kept alive across nodes: reproduce runs the spec against it before the patch (red), patch edits
// files and Vite HMR picks them up, verify runs the same spec after (green). No redeploy, no second
// server, no per-branch backend — the client talks to whatever backend the worktree's
// packages/clients/web-app/.env points at (qa, by default).
//
// If PAG_APP_URL already answers, nothing is started (a preview URL, or a server you run yourself).

import { spawn } from 'node:child_process'
import net from 'node:net'
import { loadProfile } from '../../profiles/index.mjs'

const URL_ = (repo) => process.env.PAG_APP_URL || (repo && loadProfile(repo).app.defaultUrl) || 'http://localhost:3000'
const START_TIMEOUT_MS = Number(process.env.PAG_APP_START_TIMEOUT_MS || 4 * 60_000)

let child = null
let started = false
// ONE in-flight start, shared. `next dev` takes 10-40s to open its port and compile the first
// route, and that used to happen inside the reproduce node while the clock was already running.
// ci.mjs now calls warmApp() the moment the run begins, so the server boots WHILE intake, locate
// and planning are talking to Bedrock; by the time the witness needs it, it is already answering.
// Every later ensureApp() awaits this same promise instead of racing a second server onto the port.
let booting = null

// Readiness in two steps, because one HTTP probe is wrong for a dev server. `next dev` and
// `vite` open the port immediately and compile the route on the FIRST request — which can take
// 10-30s. A short-timeout fetch aborts, and because each abort cancels the in-flight compile the
// server never finishes warming: the first version of this file looped for 90s against a server
// that was up. So: wait for the PORT with a TCP connect (instant, no compile), then warm the route
// with ONE long request.
function portOpen(u) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: Number(u.port || 80) })
    const done = (v) => { try { sock.destroy() } catch { /* already gone */ } resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(1500, () => done(false))
  })
}

async function warm(url, timeoutMs) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(url, { signal: ctl.signal, redirect: 'manual' })
    clearTimeout(t)
    return r.status > 0 && r.status < 500
  } catch { return false }
}

/**
 * Start the app in the background and return immediately. Call once, early. The returned promise
 * is what ensureApp() awaits, so calling both never starts two servers.
 */
export function warmApp({ repo, onProgress = () => {} }) {
  if (!booting) booting = ensureApp({ repo, onProgress }).catch(() => null)
  return booting
}

/** @returns {Promise<{url:string, external:boolean}|null>} null when the app cannot be brought up */
export async function ensureApp({ repo, onProgress = () => {} }) {
  // A boot already in flight (warmApp, or a previous node): wait for it rather than probing a
  // half-started server and concluding it is broken.
  if (booting) {
    const pending = booting
    booting = null
    const r = await pending
    if (r) return r
  }

  const profile = loadProfile(repo)
  const url = URL_(repo)
  const u = new URL(url)

  if (await portOpen(u)) {
    if (await warm(url, 60_000)) return { url, external: !child }
    onProgress(`${url} is listening but did not render — restarting the app`)
    stopApp()
  }
  if (started && !child) stopApp()

  const port = String(u.port || 3000)
  const argv = profile.app.argv(port)
  onProgress(`starting the app on ${url} (${profile.name}: npx ${argv.join(' ')})`)
  child = spawn('npx', argv, {
    cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
  })
  started = true
  let tail = ''
  const keep = (d) => { tail = (tail + d).slice(-4000) }
  child.stdout.on('data', keep); child.stderr.on('data', keep)
  child.on('exit', () => { child = null })

  const t0 = Date.now()
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    if (!child) { onProgress(`the app exited while starting:\n${tail.slice(-1500)}`); return null }
    if (await portOpen(u)) {
      onProgress(`port ${port} is open after ${((Date.now() - t0) / 1000).toFixed(0)}s — compiling the first route`)
      if (await warm(url, Math.max(30_000, START_TIMEOUT_MS - (Date.now() - t0)))) {
        onProgress(`app ready at ${url} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
        return { url, external: false }
      }
      onProgress(`first request did not render:\n${tail.slice(-1200)}`)
      stopApp(); return null
    }
    await new Promise((r) => setTimeout(r, 1_500))
  }
  onProgress(`the app did not open port ${port} within ${START_TIMEOUT_MS / 1000}s:\n${tail.slice(-1500)}`)
  stopApp()
  return null
}

export function stopApp() {
  booting = null
  if (!child) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } }
  child = null
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, () => { stopApp(); if (sig !== 'exit') process.exit(130) })
