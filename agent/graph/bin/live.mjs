#!/usr/bin/env node
// The one command. Run from agent/graph:
//
//   npm run live -- ESI2-3194                          one ticket
//   npm run live -- ESI2-3194 ESI2-3355 ESI2-3305      several, one after another
//
// Before the first ticket, concurrently: the backend graph/.env points at is refreshed from the live
// registry (the same choice as the last `npm run backend` — qa by default), and the worktree is reset
// to origin/<base> with node_modules linked (`npm run wt`). Then each ticket runs the full graph
// (intake → locate → plan → reproduce → patch → verify → deploy → browser QA → publish) in its own
// process. Tickets run SEQUENTIALLY on purpose: there is one worktree, one dev server on :3000 and
// one browser, and QA cannot share them — the parallelism that is safe (app warm-up, index, gate lint
// + test, screenshot reads) already happens inside each run. Between tickets the worktree is reset
// again so nothing from one ticket leaks into the next. Flags after the keys (--dry-run) pass through.
import '../src/lib/boot.mjs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { currentChoice, pointAt, describe } from './backend.mjs'

const argv = process.argv.slice(2)
const keys = argv.filter((a) => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(a))
const flags = argv.filter((a) => !keys.includes(a))
if (!keys.length) { console.error('usage: npm run live -- <ISSUE-KEY> [<ISSUE-KEY> …] [--dry-run]'); process.exit(1) }

const repo = process.env.PAG_WORKTREE || path.join(os.homedir(), 'pioneer-agent')
const product = process.env.PAG_PRODUCT || path.join(os.homedir(), 'pioneer')
const base = process.env.PAG_BASE || 'main'
const bin = (f) => path.join(import.meta.dirname, f)
const run = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { stdio: 'inherit', env: process.env })
  c.on('exit', (code) => resolve(code ?? 1))
})
const worktree = () => run([bin('prepare-worktree.mjs'), '--repo', repo, '--from', product, '--base', base])

// 1. backend + worktree, concurrently — both are seconds, and neither depends on the other.
const choice = currentChoice() || { branch: 'qa' }
const [backend, wtCode] = await Promise.all([
  pointAt(choice.branch, choice.developer).then((api) => { console.log(`\n  backend  ${describe(api).replace(/\n/g, '\n           ')}`); return api }, (e) => { console.error(`\n  backend  ${e.message} — keeping the values already in graph/.env`); return null }),
  worktree(),
])
if (wtCode !== 0) { console.error(`\n  the worktree at ${repo} is not runnable — fix the message above and rerun`); process.exit(wtCode) }

// 2. the tickets, one after another.
const results = []
for (const [i, key] of keys.entries()) {
  if (i > 0) { console.log(`\n  ── next ticket: resetting ${repo} to origin/${base} ──`); const c = await worktree(); if (c !== 0) { results.push({ key, code: c, note: 'worktree reset failed' }); break } }
  console.log(`\n  ══ ${key} (${i + 1}/${keys.length}) ══`)
  const code = await run([bin('ci.mjs'), '--repo', repo, '--base', base, key, ...flags])
  results.push({ key, code })
}

if (keys.length > 1) {
  console.log('\n  summary')
  for (const r of results) console.log(`    ${r.key.padEnd(12)} ${r.code === 0 ? 'finished' : `exited ${r.code}${r.note ? ` (${r.note})` : ''}`} — runs/${r.key}/`)
}
process.exit(results.every((r) => r.code === 0) ? 0 : 1)
