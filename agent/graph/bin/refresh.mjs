#!/usr/bin/env node
import '../src/lib/boot.mjs'
// The background refresher. Prepares a base commit so no ticket ever waits for one.
//
//   node bin/refresh.mjs --repo ~/pioneer-refresh --base main
//   node bin/refresh.mjs --repo ~/pioneer-refresh --base main --force     # re-prepare current sha
//
// Runs on a schedule (launchd locally, EventBridge -> Fargate in prod). Idempotent and safe to run
// while a ticket is in flight, because it uses its OWN worktree — never the agent's.
//
// What it does, in order:
//   1. fetch origin/<base>; if the sha is unchanged and the pin is valid, exit in ~2s
//   2. ask nx which projects a merge actually AFFECTED between the old pin and the new sha
//   3. invalidate only those project baselines
//   4. rebuild index.json (~30s) and re-mine history.json — the context tree
//   5. re-baseline the invalidated projects (nobody is waiting, so this can take its time)
//   6. write the pin, which is what marks the commit READY for runs
//
// Step 2 is why this stays cheap on a team that merges often: a typical merge touches a handful of
// projects, so a refresh costs a handful of project test runs rather than 223.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import * as snap from '../src/lib/snapshot.mjs'
import { parseFailures, parseFailedTasks } from '../src/lib/baseline.mjs'

const exec = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }
const has = (n) => argv.includes(`--${n}`)
const abs = (p) => path.resolve(String(p).replace(/^~/, process.env.HOME))

const repo = abs(flag('repo', path.join(process.env.HOME, 'pioneer-refresh')))
const base = String(flag('base', process.env.PAG_BASE_BRANCH || 'main'))
const maxProjects = Number(flag('max-projects', 40))
const t0 = Date.now()
const say = (m) => console.log(`  ${m}`)
const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`

if (!fs.existsSync(path.join(repo, '.git'))) {
  console.error(`\n${repo} is not a git worktree. Create the refresher's own worktree once:`)
  console.error(`  node bin/prepare-worktree.mjs --repo ${repo} --from ~/pioneer --base ${base} --install\n`)
  process.exit(1)
}
if (!fs.existsSync(path.join(repo, 'node_modules', '.bin', 'nx'))) {
  console.error(`\n${repo} has no node_modules — nx cannot run.`)
  console.error(`  node bin/prepare-worktree.mjs --repo ${repo} --from ~/pioneer --install\n`)
  process.exit(1)
}

// ---- 1. has main moved? ----------------------------------------------------------------------
await exec('git', ['fetch', 'origin', base, '--quiet'], { cwd: repo, maxBuffer: 1 << 26 })
const { stdout: shaOut } = await exec('git', ['rev-parse', `origin/${base}`], { cwd: repo })
const sha = shaOut.trim()
const pin = snap.readPin()

console.log('')
say(`origin/${base} @ ${sha.slice(0, 7)}${pin ? `   pinned: ${pin.sha.slice(0, 7)} (${snap.pinAgeHours().toFixed(1)}h ago)` : '   no pin yet'}`)

if (pin && pin.sha === sha && !has('force')) {
  say(`unchanged — nothing to do (${el()})`)
  console.log('')
  process.exit(0)
}

// A run may be reading the pin right now. Leave it pointing at the old, still-valid snapshot until
// this one is fully prepared, then swap. A half-prepared pin is worse than a slightly stale one.
await exec('git', ['checkout', '--detach', sha, '--quiet'], { cwd: repo })
await exec('git', ['reset', '--hard', sha, '--quiet'], { cwd: repo })
await exec('git', ['clean', '-fdq'], { cwd: repo })

// ---- 2. what did the merge actually touch? ---------------------------------------------------
let affected = null
if (pin?.sha && !has('force')) {
  try {
    const { stdout } = await exec('npx', ['nx', 'show', 'projects', '--affected', '--base', pin.sha, '--head', sha], { cwd: repo, maxBuffer: 1 << 24 })
    affected = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    say(`nx: ${affected.length} project(s) affected between ${pin.sha.slice(0, 7)} and ${sha.slice(0, 7)}`)
  } catch (e) {
    // Old sha unreachable (force-push, shallow clone) or graph error: fail SAFE by invalidating
    // everything rather than trusting stale baselines.
    say(`nx affected failed (${String(e.message).slice(0, 60)}) — invalidating all baselines`)
    affected = null
  }
} else {
  say(has('force') ? 'forced — invalidating all baselines' : 'first run — no prior pin to diff against')
}

// ---- 3. invalidate ---------------------------------------------------------------------------
const known = snap.knownProjects()
const invalidated = affected === null ? known : affected.filter((p) => known.includes(p))
for (const p of invalidated) snap.forget(p)
say(`invalidated ${invalidated.length} of ${known.length} cached project baseline(s)`)

// ---- 4. the context tree ---------------------------------------------------------------------
const ROOT = path.resolve(import.meta.dirname, '../..')
const cli = path.join(ROOT, 'src/cli.mjs')
for (const [args, label] of [
  [[cli, 'index', '--repo', repo], 'index'],
  [[cli, 'mine', '--repo', repo, '--since', String(flag('since', '2024-06-01'))], 'history'],
]) {
  const s = Date.now()
  try {
    await exec('node', args, { cwd: ROOT, maxBuffer: 1 << 26 })
    say(`${label} rebuilt (${((Date.now() - s) / 1000).toFixed(1)}s)`)
  } catch (e) {
    console.error(`\n  ${label} FAILED: ${String(e.message).slice(0, 200)}\n`)
    process.exit(1)
  }
}

// ---- 5. re-baseline what was invalidated -----------------------------------------------------
// Deliberately NOT the whole suite. `--all` on first run, then only the affected slice.
let toBaseline = affected === null ? null : invalidated
if (toBaseline && toBaseline.length > maxProjects) {
  say(`${toBaseline.length} projects affected (> --max-projects ${maxProjects}) — baselining all instead`)
  toBaseline = null
}

const runTests = (projects) => new Promise((resolve) => {
  const a = ['nx', 'run-many', '-t', 'test',
    ...(projects ? ['-p', projects.join(',')] : ['--all']),
    '--parallel=4', '--output-style=stream', '--skip-nx-cache']
  let out = ''
  const c = spawn('npx', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  c.stdout.on('data', (d) => { out += d })
  c.stderr.on('data', (d) => { out += d })
  c.on('close', () => resolve(out))
  c.on('error', (e) => resolve(out + String(e)))
})

if (toBaseline && toBaseline.length === 0) {
  say('no project baselines needed re-computing')
} else {
  const label = toBaseline ? `${toBaseline.length} affected project(s)` : 'the full suite'
  say(`baselining ${label} — this is the slow part, and nothing is waiting on it`)
  const s = Date.now()
  const out = await runTests(toBaseline)
  const tasks = parseFailedTasks(out)
  const tests = parseFailures(out)

  if (!/Test Suites:|Tests:|No tests found|Successfully ran target test|Failed tasks:|nx run /.test(out)) {
    console.error('\n  the suite produced no test output — refusing to write a snapshot')
    for (const l of out.trim().split('\n').slice(-25)) console.error(`    ${l}`)
    process.exit(1)
  }

  // Every project we RAN gets a record, red or green. A project with no record is "unknown", and
  // the gate must compute it on demand rather than assume green — that assumption is what made a
  // zero baseline dangerous.
  const ran = toBaseline || [...new Set(
    [...out.matchAll(/nx run ([\w@/.-]+):test/g)].map((m) => m[1])
  )]
  const failedProjects = new Set([...tasks].map((t) => t.split(':')[0]))
  for (const p of ran) {
    snap.writeProject(p, {
      sha,
      failed: failedProjects.has(p),
      tasks: [...tasks].filter((t) => t.startsWith(`${p}:`)),
      tests: failedProjects.has(p) ? [...tests] : [],
    })
  }
  say(`baselined ${ran.length} project(s), ${failedProjects.size} red (${((Date.now() - s) / 1000 / 60).toFixed(1)} min)`)
}

// ---- 6. mark READY --------------------------------------------------------------------------
snap.writePin({ sha, base, indexedAt: new Date().toISOString(), projects: snap.knownProjects().length })
say(`READY — runs will now pin to ${base}@${sha.slice(0, 7)}  (${el()})`)
console.log('')
