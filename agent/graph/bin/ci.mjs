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
import { stopApp } from '../src/lib/app.mjs'

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

const issueKey = argv[0]
if (!issueKey || issueKey.startsWith('--')) { console.error('usage: ci.mjs <ISSUE-KEY> [--repo .] [--base main] [--target main] [--dry-run]'); process.exit(1) }

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

// ---- 2. baseline the gate on the CLEAN checkout ----------------------------------------------
//
// Without this, every failure the gate sees is attributed to the patch. On KAN-6 the only lint
// error in the repo was in the agent's own vendored source — `npm run lint` covers the whole repo —
// so a correct patch was blamed for it, repair spent its budget trying to fix code it had not
// touched, and the run died on the clock. Recording what already fails, before anything is edited,
// is the difference between "N failures" and "N NEW failures".
//
// Only for profiles where the whole gate is cheap (nextjs: under a minute). On an nx monorepo this
// is the refresher's job, per merge, for the projects a merge actually affected.
let baselined = 0
if (profile.baselineAll && !has('skip-baseline')) {
  const { execFile } = await import('node:child_process')
  const run = (argv) => new Promise((resolve) => {
    execFile('npx', argv, { cwd: repo, maxBuffer: 1 << 26, timeout: 8 * 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` })
    })
  })

  const plan = profile.gate(repo, { owners: ['app'], typeConsumers: [] })
  const failingTargets = new Set()
  const failingTests = new Set()
  const t1 = Date.now()
  for (const { target, projects, argv } of plan) {
    const { ok, out } = await run(argv)
    if (ok) continue
    for (const p of projects) failingTargets.add(`${p}:${target}`)
    if (target === 'test') {
      for (const id of parseFailures(out)) failingTests.add(id)
      for (const id of parseFailedTasks(out)) failingTargets.add(id)
    }
  }
  for (const p of [...new Set(plan.flatMap((x) => x.projects))]) {
    snap.writeProject(p, {
      sha: baseSha,
      failed: [...failingTargets].some((id) => id.startsWith(`${p}:`)),
      tasks: [...failingTargets].filter((id) => id.startsWith(`${p}:`)),
      tests: [...failingTests],
    })
    baselined++
  }
  console.log(`  baseline: ${baselined} project(s) in ${((Date.now() - t1) / 1000).toFixed(0)}s`
    + (failingTargets.size ? ` — already failing on ${baseSha.slice(0, 7)}: ${[...failingTargets].join(', ')}` : ' — all green'))
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
console.log(`  cap $${budget.capUsd} (reserve $${budget.reserveUsd}) · wall-clock target ${budget.maxMinutes} min`)
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

const graph = buildGraph({ budget, checkpointer: new MemorySaver(), trace, dryRun, onProgress })
const t0 = Date.now()
let final = {}
let crashed = null
try {
  for await (const chunk of await graph.stream(
    { issueKey, repo, baseBranch, prTargetBranch, baseSha, branchName: `${process.env.PAG_BRANCH_PREFIX || 'agent/'}${issueKey}-${slug}` },
    { configurable: { thread_id: `${issueKey}-${baseSha.slice(0, 7)}` }, recursionLimit: 40, streamMode: 'updates' }
  )) {
    for (const [node, update] of Object.entries(chunk)) {
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
  crashed = { at: 'unknown', reason: err?.name || 'node_threw', detail: String(err?.message || err).slice(0, 2000) }
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
if (final?.prUrl) console.log(`\n  DRAFT PR: ${final.prUrl}\n`)
else if (final?.refusal) console.log(`\n  refused at ${final.refusal.at}: ${final.refusal.reason}\n`)

// Hand the run folder to the workflow, which turns it into the job summary and an artifact.
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, [
    `run_dir=${path.relative(process.cwd(), trace.dir)}`,
    `pr_url=${final?.prUrl || ''}`,
    `refusal=${final?.refusal?.reason || ''}`,
    `evidence=${final?.repro?.status === 'red' && final?.evidence?.reproGreen ? (final.repro.rung === 'e2e' ? 'e2e' : 'repro') : 'none'}`,
    `spent=${led.spent.toFixed(4)}`,
  ].join('\n') + '\n')
}
process.exit(final?.refusal ? 3 : 0)
