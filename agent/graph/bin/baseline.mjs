#!/usr/bin/env node
// Snapshot the failures that already exist on the base branch. Run once per base commit.
//
//   node bin/baseline.mjs --repo ~/pioneer-agent --base main
//
// This is the mechanised version of Cody's `known-baseline-failures.md`. Same insight — stop
// re-deriving the same 133 pre-existing failures on every run — but as data the GATE can subtract,
// not prose a model has to read and believe. It also refreshes itself when the base moves, which
// the hand-written file could not.

import '../src/lib/boot.mjs'   // loads graph/.env before anything reads process.env
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import * as baseline from '../src/lib/baseline.mjs'

const exec = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }

const repo = path.resolve(String(flag('repo', '')).replace(/^~/, process.env.HOME))
const base = String(flag('base', 'main'))
const projects = flag('projects')   // optional: limit the snapshot to a project list

await exec('git', ['fetch', 'origin', base], { cwd: repo })
const { stdout: sha } = await exec('git', ['rev-parse', `origin/${base}`], { cwd: repo })
const baseSha = sha.trim()

// The worktree is the agent's scratch space, detached at a base commit — nothing in it is the
// operator's work. But running the suite DIRTIES it: nx generators rewrite files as a side effect
// of `test`/`build` (integrationImages.ts and the locale bundles are the usual offenders — Cody's
// validate-checks.sh logs "reverted generator drift in integrationImages.ts" for exactly this).
// So a second baseline run would otherwise refuse forever after the first one.
//
// Policy: tracked modifications are reverted automatically, because `git checkout --` restores the
// base commit's own content and cannot destroy anything. Untracked files are NOT deleted without
// --clean, since that is the one case where something of yours could be sitting there.
const { stdout: dirty } = await exec('git', ['status', '--porcelain'], { cwd: repo })
if (dirty.trim()) {
  const lines = dirty.trim().split('\n')
  const tracked = lines.filter((l) => !l.startsWith('??')).map((l) => (l.match(/^..\s+(.*)$/) || [, l])[1].replace(/^.* -> /, '').trim())
  const untracked = lines.filter((l) => l.startsWith('??')).map((l) => (l.match(/^\?\?\s+(.*)$/) || [, l])[1].trim())

  if (tracked.length) {
    console.log(`reverting ${tracked.length} generator-drift file(s) in the worktree:`)
    for (const f of tracked.slice(0, 8)) console.log(`  ${f}`)
    if (tracked.length > 8) console.log(`  … +${tracked.length - 8} more`)
    await exec('git', ['checkout', '--', '.'], { cwd: repo })
  }

  if (untracked.length) {
    if (argv.includes('--clean')) {
      console.log(`removing ${untracked.length} untracked file(s) (--clean)`)
      await exec('git', ['clean', '-fdq'], { cwd: repo })
    } else {
      console.log(`\n${untracked.length} untracked file(s) present — leaving them, they do not affect the suite:`)
      for (const f of untracked.slice(0, 8)) console.log(`  ${f}`)
      if (untracked.length > 8) console.log(`  … +${untracked.length - 8} more`)
      console.log('(pass --clean to remove them)')
    }
  }
  console.log('')
}

if (!fs.existsSync(path.join(repo, 'node_modules', '.bin', 'nx'))) {
  console.error(`\n${repo} has no node_modules — nx cannot run there.`)
  console.error('A git worktree is a fresh checkout; dependencies are not shared automatically.\n')
  console.error('Fix it once (seconds, no disk cost):')
  console.error(`  node bin/prepare-worktree.mjs --repo ${repo} --from ~/pioneer\n`)
  process.exit(1)
}

await exec('git', ['checkout', '--detach', baseSha], { cwd: repo })
console.log(`snapshotting failures on origin/${base}@${baseSha.slice(0, 7)} — this runs the suite once, expect several minutes`)

// `--output-style=stream` is load-bearing. Without it nx prints only its own summary block and no
// per-test output at all, so a jest/vitest parser sees nothing and reports "green" on a repo with
// 133 known failures. `--skip-nx-cache` matters just as much: a cached PASS would replay as a pass
// and silently poison the snapshot.
const argsFor = [
  'nx', 'run-many', '-t', 'test',
  ...(projects ? ['-p', String(projects)] : ['--all']),
  '--parallel=4',
  '--output-style=stream',
  '--skip-nx-cache',
]

let out = ''
try {
  const r = await exec('npx', argsFor, { cwd: repo, maxBuffer: 1 << 28, timeout: 60 * 60_000 })
  out = r.stdout + r.stderr
} catch (e) {
  out = `${e.stdout || ''}${e.stderr || ''}`
}

// A run that produced no test output at all did not "find zero failures" — it did not run. The
// usual cause is a fresh worktree with no node_modules, where `npx nx` exits before any test does.
const ranSomething = /Test Suites:|Tests:|No tests found|Successfully ran target test|nx run |Failed tasks:/.test(out)
if (!ranSomething) {
  console.error('\nThe test command produced no test output — the suite did not run.')
  console.error('A zero baseline is worse than none: it makes every pre-existing failure look like')
  console.error('a regression your patch caused. Refusing to save.\n')
  console.error('Last 25 lines of output:')
  for (const l of out.trim().split('\n').slice(-25)) console.error(`  ${l}`)
  console.error('\nMost likely: this worktree has no node_modules. Fix it with:')
  console.error(`  node bin/prepare-worktree.mjs --repo ${repo} --from ~/pioneer\n`)
  process.exit(1)
}

const failures = baseline.parseFailures(out)
const tasks = baseline.parseFailedTasks(out)
// A snapshot with neither granularity populated is not a green repo, it is a parse failure.
if (failures.size === 0 && tasks.size === 0) {
  console.error('\nNo failures parsed at EITHER granularity — that is a parser or output problem,')
  console.error('not a green main. Refusing to save a snapshot that would mark every real failure')
  console.error('as a regression.\n')
  console.error('Last 40 lines:')
  for (const l of out.trim().split('\n').slice(-40)) console.error(`  ${l}`)
  process.exit(1)
}

baseline.save(baseSha, failures, { base, scope: projects || 'all' }, tasks)

console.log(`\nrecorded for ${baseSha.slice(0, 7)}:`)
console.log(`  ${tasks.size} failing task(s)  ${[...tasks].slice(0, 12).join(', ')}${tasks.size > 12 ? ` … +${tasks.size - 12}` : ''}`)
console.log(`  ${failures.size} individual failing test(s)`)
if (failures.size === 0 && tasks.size > 0) {
  console.log('\n  Note: task-level only. nx did not emit per-test output for the failing tasks, so the')
  console.log('  gate will compare at task granularity — coarser, but still correct: a task that was')
  console.log('  red on the base commit and is red now is not your regression.')
}
console.log(`\n  -> .baseline/${baseSha}.json\n`)

