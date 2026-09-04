#!/usr/bin/env node
// Run one ticket end to end.
//
//   node bin/run.mjs ESI2-3376 --repo ~/pioneer-agent --base main --target qa
//   node bin/run.mjs ESI2-3376 --repo ~/pioneer-agent --dry-run     # no branch, no push, no PR
//
// The worktree is REQUIRED and must not be your main checkout. On ESI2-3376 the agent edited
// ~/pioneer in place because Cody's orchestrator assumes a throwaway CI runner clone; on a laptop
// that is your working tree. `git worktree add -b bug/KEY ~/pioneer-agent origin/main` costs
// nothing and makes the whole class of "it changed my files" impossible.

import '../src/lib/boot.mjs'   // loads graph/.env before anything reads process.env
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { MemorySaver } from '@langchain/langgraph'
import { buildGraph } from '../src/graph.mjs'
import { Budget } from '../src/lib/budget.mjs'
import { NODE_TIER, TIERS } from '../src/lib/models.mjs'
import * as snap from '../src/lib/snapshot.mjs'
import { Trace, isLangSmithOn } from '../src/lib/trace.mjs'

const exec = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) }
const has = (n) => argv.includes(`--${n}`)

// Reject unknown flags. `--baes main` silently fell back to the default on a real run — a typo'd
// flag that is ignored rather than rejected is worse than one that errors, because the run looks
// like it honoured you.
const KNOWN = new Set(['repo', 'base', 'target', 'slug', 'dry-run', 'no-baseline'])
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const name = argv[i].slice(2)
  if (KNOWN.has(name)) continue
  const near = [...KNOWN].find((k) => k.startsWith(name.slice(0, 2)) || name.startsWith(k.slice(0, 2)))
  console.error(`unknown flag --${name}${near ? `  (did you mean --${near}?)` : ''}`)
  console.error(`known flags: ${[...KNOWN].map((k) => `--${k}`).join(' ')}`)
  process.exit(1)
}

const issueKey = argv[0]
if (!issueKey || issueKey.startsWith('--')) {
  console.error('usage: run.mjs <ISSUE-KEY> --repo <worktree> [--base main] [--target qa] [--dry-run]')
  process.exit(1)
}

const repo = path.resolve(String(flag('repo', '')).replace(/^~/, process.env.HOME))
const baseBranch = String(flag('base', 'main'))
const prTargetBranch = String(flag('target', 'qa'))
const dryRun = has('dry-run')

if (!repo || !fs.existsSync(path.join(repo, '.git'))) {
  console.error(`--repo must be a git worktree. Got: ${repo || '(none)'}`)
  console.error(`  git worktree add -b bug/${issueKey.toLowerCase()} ~/pioneer-agent origin/${baseBranch}`)
  process.exit(1)
}

// Refuse to run in the same worktree the operator is using. Cheap guard, expensive mistake.
const { stdout: topLevel } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: repo })
const { stdout: common } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: repo })
if (path.resolve(repo, common.trim()) === path.resolve(topLevel.trim(), '.git')) {
  console.error(`${repo} is the PRIMARY worktree. Use a linked worktree so your own checkout is never touched:`)
  console.error(`  git worktree add -b bug/${issueKey.toLowerCase()} ~/pioneer-agent origin/${baseBranch}`)
  process.exit(1)
}


// PIN TO THE PREPARED SNAPSHOT, not to live origin/<base>.
//
// This is the change that stops a busy main branch from blocking tickets. The refresher prepares a
// commit — index, history, project baselines — and marks it READY. A run branches from THAT, so it
// never waits for a baseline and never fails because someone merged five minutes ago. Worst case it
// branches from a main one refresh interval old, which merges fine; if it doesn't, that is a real
// conflict a human should see.
const pin = snap.readPin()
if (!pin) {
  console.error(`\nNo prepared snapshot. Runs pin to a commit the refresher has prepared, so prepare one:\n`)
  console.error(`  node bin/refresh.mjs --repo ~/pioneer-refresh --base ${baseBranch}\n`)
  process.exit(2)
}
if (pin.base !== baseBranch) {
  console.error(`\nThe snapshot is for base "${pin.base}" but you asked for "${baseBranch}".`)
  console.error(`  node bin/refresh.mjs --repo ~/pioneer-refresh --base ${baseBranch}\n`)
  process.exit(2)
}
const baseSha = pin.sha
const ageH = snap.pinAgeHours()

// Put the worktree ON the pinned commit. Whatever it was left on by a previous ticket is
// irrelevant — the run owns it.
await exec('git', ['fetch', 'origin', baseBranch, '--quiet'], { cwd: repo, maxBuffer: 1 << 26 })
try {
  await exec('git', ['checkout', '--detach', baseSha, '--quiet'], { cwd: repo })
  await exec('git', ['reset', '--hard', baseSha, '--quiet'], { cwd: repo })
  await exec('git', ['clean', '-fdq'], { cwd: repo })
} catch (e) {
  console.error(`\ncould not put ${repo} on ${baseSha.slice(0, 7)}: ${String(e.message).slice(0, 160)}\n`)
  process.exit(1)
}

const slug = String(flag('slug', '')) || 'fix'
const budget = new Budget()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const trace = new Trace({ issueKey, runId })
process.env.PAG_RUN_DIR = trace.dir   // so patch can persist the diff beside the trace

console.log('')
console.log(`  ${issueKey}   worktree ${repo}`)
console.log(`  base ${baseBranch}@${baseSha.slice(0, 7)} (pinned ${ageH < 1 ? `${(ageH * 60).toFixed(0)}m` : `${ageH.toFixed(1)}h`} ago)  ->  PR into ${prTargetBranch}${dryRun ? '   [DRY RUN]' : ''}`)
console.log(`  cap $${budget.capUsd} (reserve $${budget.reserveUsd}) · wall-clock target ${budget.maxMinutes} min`)
console.log(`  models: ${Object.entries(NODE_TIER).map(([n, t]) => `${n}=${t}`).join(' ')}`)
console.log(`          fast=${TIERS.fast.model}`)
console.log(`          heavy=${TIERS.heavy.model}`)
console.log('')

const onProgress = (line) => {
  trace.note('run', line)
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
let final
for await (const chunk of await graph.stream(
  { issueKey, repo, baseBranch, prTargetBranch, baseSha, branchName: `${process.env.PAG_BRANCH_PREFIX || 'agent/'}${issueKey}-${slug}` },
  { configurable: { thread_id: `${issueKey}-${baseSha.slice(0, 7)}` }, recursionLimit: 40, streamMode: 'updates' }
)) {
  for (const [node, update] of Object.entries(chunk)) {
    const spent = budget.report().spent
    console.log(`  ▸ ${node.padEnd(8)}  $${spent.toFixed(4)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    if (node === 'locate' && update.located) for (const p of update.located) console.log(`      ${p.path}`)
    if (node === 'planning' && update.plan) console.log(`      impactedFiles: ${update.plan.impactedFiles?.join(', ')}`)
    if (node === 'reproduce' && update.repro) console.log(`      repro ${update.repro.status}${update.repro.file ? ': ' + update.repro.file : ''}${update.repro.reason ? ' — ' + update.repro.reason : ''}`)
    if (node === 'patch' && update.diffStat) console.log(`      ${update.diffStat.files} files +${update.diffStat.insertions}/-${update.diffStat.deletions}`)
    if (node === 'verify' && update.gate) console.log(`      ${update.gate.summary}`)
    final = { ...final, ...update }
  }
  trace.timeline(budget.report())
}

const led = budget.report()
console.log('')
console.log(`  spent $${led.spent.toFixed(4)} of $${led.capUsd} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log(`  by node: ${Object.entries(led.byNode).map(([n, v]) => `${n} $${v.toFixed(3)}`).join('  ')}`)
if (final?.prUrl) console.log(`\n  DRAFT PR: ${final.prUrl}\n`)
else if (final?.refusal) console.log(`\n  refused at ${final.refusal.at}: ${final.refusal.reason}\n`)
process.exit(final?.refusal ? 3 : 0)
