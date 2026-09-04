#!/usr/bin/env node
// CI entrypoint: one ticket -> evidence -> draft PR, inside a fresh GitHub Actions checkout.
//
//   node agent/graph/bin/ci.mjs ATL-12 --repo "$GITHUB_WORKSPACE" --base main --target main --dry-run
//
// Why this exists instead of bin/run.mjs: run.mjs is built for a laptop. It REFUSES the primary
// worktree (so the agent can never edit your own checkout) and it requires a snapshot the
// background refresher prepared. In CI both of those are wrong by construction — the runner's
// checkout IS the primary worktree and it is disposable, and there is no refresher, so this script
// prepares the snapshot itself from HEAD:
//
//   1. build agent/.par/index.json (+ history.json mined from merged PRs, when the repo has any)
//   2. pin the snapshot at HEAD — the commit the run branches from and the gate compares against
//   3. run the graph
//
// Baselines are deliberately NOT recorded here: a fresh checkout of a green main has nothing to
// subtract, and verify's unknown-but-green rule reports an unattributable failure as such rather
// than blaming the patch.

import '../src/lib/boot.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { MemorySaver } from '@langchain/langgraph'
import { buildGraph } from '../src/graph.mjs'
import { Budget } from '../src/lib/budget.mjs'
import { NODE_TIER, TIERS } from '../src/lib/models.mjs'
import * as snap from '../src/lib/snapshot.mjs'
import { parseFailures, parseFailedTasks } from '../src/lib/baseline.mjs'
import { Trace } from '../src/lib/trace.mjs'
import { loadProfile } from '../profiles/index.mjs'
import { stopApp, warmApp } from '../src/lib/app.mjs'

const exec = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) }
const has = (n) => argv.includes(`--${n}`)

const KNOWN = new Set(['repo', 'base', 'target', 'slug', 'dry-run', 'skip-index', 'skip-baseline'])
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const name = argv[i].slice(2)
  if (!KNOWN.has(name)) { console.error(`unknown flag --${name}\nknown: ${[...KNOWN].map((k) => `--${k}`).join(' ')}`); process.exit(1) }
}

// The key can sit anywhere in the arguments, not only first. `npm run dry -- ESI2-3393` expands to
// `node bin/ci.mjs --repo … --dry-run ESI2-3393`, and requiring position 0 made every npm script
// wrapper impossible for no reason.
const issueKey = argv.find((a) => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(a))
if (!issueKey) { console.error('usage: ci.mjs <ISSUE-KEY> [--repo .] [--base main] [--target main] [--dry-run]'); process.exit(1) }

const repo = path.resolve(String(flag('repo', process.env.GITHUB_WORKSPACE || process.cwd())))
const baseBranch = String(flag('base', process.env.PAG_BASE_BRANCH || 'main'))
const prTargetBranch = String(flag('target', process.env.PAG_PR_TARGET || baseBranch))
const dryRun = has('dry-run')
const ROOT = path.resolve(import.meta.dirname, '../..')          // agent/
const PAR = process.env.PAG_PAR_DIR || path.join(ROOT, '.par')

if (!fs.existsSync(path.join(repo, '.git'))) { console.error(`--repo is not a git checkout: ${repo}`); process.exit(1) }

const profile = loadProfile(repo)
const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })
const baseSha = shaOut.trim()

// ---- 1. the context tree, from THIS checkout -------------------------------------------------
if (!has('skip-index')) {
  fs.mkdirSync(PAR, { recursive: true })
  const cli = path.join(ROOT, 'src/cli.mjs')
  const t0 = Date.now()
  await exec('node', [cli, 'index', '--repo', repo, '--out', path.join(PAR, 'index.json')], { cwd: ROOT, maxBuffer: 1 << 26 })
  // History is mined from merged PRs that carry a ticket key. A young repo has none; that is fine,
  // the router just loses one signal.
  await exec('node', [cli, 'mine', '--repo', repo, '--out', path.join(PAR, 'history.json')], { cwd: ROOT, maxBuffer: 1 << 26 })
    .catch((e) => console.log(`  history: skipped (${String(e.message).split('\n')[0].slice(0, 80)})`))
  const n = (() => { try { return JSON.parse(fs.readFileSync(path.join(PAR, 'index.json'), 'utf8')).files?.length ?? '?' } catch { return '?' } })()
  console.log(`  index: ${n} file(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---- 1b. generate framework types, so `tsc --noEmit` is a real check --------------------------
//
// app/layout.tsx uses `LayoutProps<"/">`, which Next writes into .next/types. On a fresh checkout
// that directory does not exist, so `tsc --noEmit` fails before anything is edited — on KAN-11 the
// baseline correctly recorded `app:typecheck` as already-failing on the pinned commit and the gate
// ignored it for the rest of the run. That is the baseline doing its job, and it is also a gate
// target that can never catch a real type error. `next typegen` costs a couple of seconds.
if (profile.name === 'nextjs') {
  await exec('npx', ['next', 'typegen'], { cwd: repo, timeout: 120_000 })
    .then(() => console.log('  typegen: .next/types generated — typecheck is now a real gate'))
    .catch((e) => console.log(`  typegen: skipped (${String(e.message).split('\n')[0].slice(0, 70)}) — typecheck may baseline as already-failing`))
}

// ---- 2. baseline the gate on the CLEAN checkout — CONCURRENTLY ------------------------------
//
// Without a baseline, every failure the gate sees is attributed to the patch. On KAN-6 the only
// lint error in the repo was in the agent's own vendored source — `npm run lint` covers the whole
// repo — so a correct patch was blamed for it, repair spent its budget fixing code it had not
// touched, and the run died on the clock. Recording what already fails, before anything is edited,
// is the difference between "N failures" and "N NEW failures".
//
// WHY IT NO LONGER BLOCKS: this is a full lint + typecheck + test + build of the clean checkout,
// 60-120s, and it used to run to completion before intake had read the ticket. Nothing needs its
// answer until `verify`, which is six minutes downstream. So it starts here as a promise and
// `snap.ready()` is awaited inside verify, immediately before the store is consulted. On every run
// measured so far that wait is zero — the baseline finishes during `patch`.
//
// Only for profiles where the whole gate is cheap (nextjs: under a minute). On an nx monorepo this
// is the refresher's job, per merge, for the projects a merge actually affected.
const baselineProjects = [...new Set(profile.gate(repo, { owners: ['app'], typeConsumers: [] }).flatMap((x) => x.projects))]
let baselined = 0

if (profile.baselineAll && !has('skip-baseline')) {
  baselined = baselineProjects.length
  const run = (argv) => new Promise((resolve) => {
    const bin = argv[0] === 'npm' || argv[0] === 'npx' ? argv[0] : 'npx'
    const rest = argv[0] === 'npm' || argv[0] === 'npx' ? argv.slice(1) : argv
    execFile(bin, rest, { cwd: repo, maxBuffer: 1 << 26, timeout: 8 * 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` })
    })
  })

  snap.setPending((async () => {
    const plan = profile.gate(repo, { owners: ['app'], typeConsumers: [] })
    const failingTargets = new Set()
    const failingTests = new Set()
    const t1 = Date.now()
    // Same split as the gate itself: the read-only targets together, the exclusive ones alone.
    // This is the clean checkout, so nothing else is using the build directory yet.
    const results = [
      ...await Promise.all(plan.filter((c) => !c.exclusive).map(async (c) => ({ ...c, ...(await run(c.argv)) }))),
    ]
    for (const c of plan.filter((c) => c.exclusive)) results.push({ ...c, ...(await run(c.argv)) })
    for (const { target, projects, ok, out } of results) {
      if (ok) continue
      for (const p of projects) failingTargets.add(`${p}:${target}`)
      if (target === 'test') {
        for (const id of parseFailures(out)) failingTests.add(id)
        for (const id of parseFailedTasks(out)) failingTargets.add(id)
      }
    }
    for (const p of baselineProjects) {
      snap.writeProject(p, {
        sha: baseSha,
        failed: [...failingTargets].some((id) => id.startsWith(`${p}:`)),
        tasks: [...failingTargets].filter((id) => id.startsWith(`${p}:`)),
        tests: [...failingTests],
      })
    }
    console.log(`  baseline: ${baselineProjects.length} project(s) in ${((Date.now() - t1) / 1000).toFixed(0)}s (concurrent)`
      + (failingTargets.size ? ` — already failing on ${baseSha.slice(0, 7)}: ${[...failingTargets].join(', ')}` : ' — all green'))
  })())
  console.log(`  baseline: started in the background for ${baselineProjects.join(', ')}`)
}

// ---- 3. pin at HEAD --------------------------------------------------------------------------
snap.writePin({ sha: baseSha, base: baseBranch, indexedAt: new Date().toISOString(), projects: baselined })

// ---- 4. run ----------------------------------------------------------------------------------
const budget = new Budget()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const trace = new Trace({ issueKey, runId })
process.env.PAG_RUN_DIR = trace.dir

const slug = String(flag('slug', '')) || 'fix'
console.log('')
console.log(`  ${issueKey}   ${profile.name} profile   ${repo}`)
console.log(`  base ${baseBranch}@${baseSha.slice(0, 7)}  ->  PR into ${prTargetBranch}${dryRun ? '   [DRY RUN]' : ''}`)
console.log(`  cap $${budget.capUsd} (reserve $${budget.reserveUsd}) · hard deadline ${budget.maxMinutes} min`)
console.log(`  clock: repro ${(budget.timeFor('reproduce') / 1000).toFixed(0)}s · patch ${(budget.timeFor('patch') / 1000).toFixed(0)}s · verify ${(budget.timeFor('verify') / 1000).toFixed(0)}s, and publish is always reserved`)
console.log(`  models: fast=${TIERS.fast.model}  heavy=${TIERS.heavy.model}`)
console.log(`  witness: ${process.env.PAG_UI_EVIDENCE === '1' ? (process.env.PAG_APP_EMAIL ? 'on (with app login)' : 'on (unauthenticated pages only)') : 'off'}`)
console.log('')

const onProgress = (line) => {
  trace.note('ci', line)
  const s = String(line).trim()
  if (!s) return
  if (s.startsWith('{')) {
    try {
      const e = JSON.parse(s)
      if (e.type === 'assistant' && e.message?.content) {
        for (const c of e.message.content) {
          if (c.type === 'text' && c.text?.trim()) console.log(`      ${c.text.trim().slice(0, 160)}`)
          if (c.type === 'tool_use') console.log(`      · ${c.name} ${JSON.stringify(c.input).slice(0, 110)}`)
        }
      }
      if (e.type === 'result') console.log(`      ■ ${e.subtype} $${(e.total_cost_usd ?? 0).toFixed(4)}`)
    } catch { /* partial line */ }
    return
  }
  console.log(`      ${s}`)
}

// Boot the app NOW, not when the witness asks for it. `next dev` takes 10-40s to open its port
// and compile the first route, and that used to be dead clock inside the reproduce phase. Starting
// it here means it warms while intake, locate and planning are round-tripping to Bedrock, and the
// witness finds a server already answering. lib/app.mjs shares the one in-flight boot, so this
// never races a second server onto the port.
if (process.env.PAG_UI_EVIDENCE === '1') {
  warmApp({ repo, onProgress: (l) => console.log(`      ${l}`) })
  console.log(`  app: warming ${process.env.PAG_APP_URL || 'the dev server'} in the background`)
}

const graph = buildGraph({ budget, checkpointer: new MemorySaver(), trace, dryRun, onProgress })
const t0 = Date.now()
let final = {}
let crashed = null
let lastNode = 'start'      // so a crash can say WHERE, instead of 'unknown'
try {
  for await (const chunk of await graph.stream(
    { issueKey, repo, baseBranch, prTargetBranch, baseSha, branchName: `${process.env.PAG_BRANCH_PREFIX || 'agent/'}${issueKey}-${slug}` },
    { configurable: { thread_id: `${issueKey}-${baseSha.slice(0, 7)}` }, recursionLimit: 40, streamMode: 'updates' }
  )) {
    for (const [node, update] of Object.entries(chunk)) {
      lastNode = node
      console.log(`  ▸ ${node.padEnd(9)}  $${budget.report().spent.toFixed(4)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      if (node === 'locate' && update.located) for (const p of update.located) console.log(`      ${p.path}`)
      if (node === 'planning' && update.plan) console.log(`      impactedFiles: ${update.plan.impactedFiles?.join(', ')}`)
      if (node === 'reproduce' && update.repro) console.log(`      repro ${update.repro.status} (${update.repro.rung})${update.repro.reason ? ' — ' + update.repro.reason : ''}`)
      if (node === 'patch' && update.diffStat) console.log(`      ${update.diffStat.files} files +${update.diffStat.insertions}/-${update.diffStat.deletions}`)
      if (node === 'verify' && update.gate) console.log(`      ${update.gate.summary}`)
      final = { ...final, ...update }
    }
    trace.timeline(budget.report())
  }
} catch (err) {
  // A node that throws must not take the run's REPORT with it. The first CI run on KAN-6 died on a
  // Bedrock 503 with a bare stack trace: no timeline, no artifact worth reading, exit 1 from an
  // unhandled rejection. A throw is now just another terminal outcome — recorded, summarised, and
  // exited with the refusal code so the workflow's summary and artifact steps still run.
  // `err.name` is 'Error' for almost everything thrown by hand, so "refused at unknown: Error" was
  // the entire report on a crash. The first line of the message is the part a human can act on.
  const first = String(err?.message || err).split('\n')[0]
  crashed = {
    at: lastNode,
    reason: err?.name && err.name !== 'Error' ? err.name : (first.slice(0, 70) || 'node_threw'),
    detail: String(err?.message || err).slice(0, 2000),
  }
  final = { ...final, refusal: crashed }
  console.error(`\n  CRASHED: ${crashed.reason}\n  ${crashed.detail}\n`)
  trace.note('ci', `CRASHED ${crashed.reason}: ${crashed.detail}`)
  trace.timeline(budget.report())
} finally {
  stopApp()
}

const led = budget.report()
console.log('')
console.log(`  spent $${led.spent.toFixed(4)} of $${led.capUsd} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log(`  by node: ${Object.entries(led.byNode).map(([n, v]) => `${n} $${v.toFixed(3)}`).join('  ')}`)
console.log(`  phases:  ${(led.phases || []).map((p) => `${p.node} ${(p.ms / 1000).toFixed(0)}s`).join('  ')}`)
if (led.elapsedMs > led.maxMinutes * 60_000) console.log(`  ⚠ OVER the ${led.maxMinutes}-minute deadline by ${((led.elapsedMs - led.maxMinutes * 60_000) / 1000).toFixed(0)}s — check which phase overran above`)
if (final?.prUrl) console.log(`\n  ${final?.incomplete ? 'INCOMPLETE HAND-OVER' : 'DRAFT PR'}: ${final.prUrl}\n`)
else if (final?.refusal) console.log(`\n  refused at ${final.refusal.at}: ${final.refusal.reason}\n`)

// Hand the run folder to the workflow, which turns it into the job summary and an artifact.
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, [
    `run_dir=${path.relative(process.cwd(), trace.dir)}`,
    `pr_url=${final?.prUrl || ''}`,
    `refusal=${final?.refusal?.reason || ''}`,
    `incomplete=${final?.incomplete ? '1' : ''}`,
    `branch=${final?.branchName || ''}`,
    `elapsed=${Math.round((led.elapsedMs || 0) / 1000)}`,
    `evidence=${final?.repro?.status === 'red' && final?.evidence?.reproGreen ? (final.repro.rung === 'e2e' ? 'e2e' : 'repro') : 'none'}`,
    `spent=${led.spent.toFixed(4)}`,
  ].join('\n') + '\n')
}
process.exit(final?.refusal ? 3 : 0)
