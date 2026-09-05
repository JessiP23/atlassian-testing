#!/usr/bin/env node
// Make a git worktree runnable. Creates it if missing, then gives it node_modules.
//
//   node bin/prepare-worktree.mjs --repo ~/pioneer-agent --from ~/pioneer --base main
//
// WHY THIS IS NEEDED
// A git worktree is a fresh checkout of the tree — it shares .git, not node_modules. So a brand new
// worktree cannot run `nx`, `jest` or `tsc` at all, and the failure is silent and confusing: npx
// exits before any test does, so a baseline snapshot records "0 pre-existing failures" and every
// pre-existing failure afterwards looks like a regression the agent caused. That is the precise
// defect the baseline mechanism exists to remove, so it must not be reintroduced by the setup step.
//
// SYMLINK, NOT INSTALL
// This monorepo's node_modules is ~2.2 GB and takes many minutes to install. A symlink to a
// reference checkout costs nothing and takes a second. It is safe as long as the two trees resolve
// the same dependency graph, so the lockfiles are compared and a mismatch is reported rather than
// silently tolerated — a mismatch means the worktree would build against the wrong versions, which
// is a much subtler bug than a missing directory.
//
// Nx's own cache is left alone: it is content-hashed, so sharing or not sharing is equally correct.

import '../src/lib/boot.mjs'   // loads graph/.env before anything reads process.env
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const exec = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }
const abs = (p) => path.resolve(String(p).replace(/^~/, process.env.HOME))

const repo = abs(flag('repo', ''))
const from = abs(flag('from', path.join(process.env.HOME, 'pioneer')))
const base = String(flag('base', 'main'))
const branch = flag('branch') || `bug/pag-${path.basename(repo)}`

if (!flag('repo')) {
  console.error('usage: prepare-worktree.mjs --repo <worktree path> [--from ~/pioneer] [--base main] [--branch <name>]')
  process.exit(1)
}
if (!fs.existsSync(path.join(from, '.git'))) {
  console.error(`--from ${from} is not a git checkout`)
  process.exit(1)
}

const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : null)

// ---- 1. create the worktree if it is not there ----------------------------------------------
if (!fs.existsSync(path.join(repo, '.git'))) {
  console.log(`creating worktree ${repo} on ${branch} from origin/${base}`)
  await exec('git', ['worktree', 'prune'], { cwd: from })
  await exec('git', ['fetch', 'origin', base], { cwd: from, maxBuffer: 1 << 26 })
  await exec('git', ['worktree', 'add', '-B', branch, repo, `origin/${base}`], { cwd: from, maxBuffer: 1 << 26 })
  console.log('  created')
} else {
  console.log(`worktree exists: ${repo}`)

  // PUT IT BACK ON THE BASE. A worktree is disposable by design, and leaving the previous
  // ticket's patch in it silently destroys the next run's premise: on ESI2-3393 the reproduce node
  // reported "the worktree is not in the unpatched state the protocol assumes" and had to revert
  // format-filter-value.ts by hand, because the fix from the previous run was still applied. A
  // "red before the fix" measured against a tree that already has the fix is not evidence of
  // anything. Reset is the default here for exactly that reason; --no-reset opts out.
  if (!argv.includes('--no-reset')) {
    await exec('git', ['fetch', '--quiet', 'origin', base], { cwd: repo }).catch(() => {})
    const { stdout: dirty } = await exec('git', ['status', '--porcelain'], { cwd: repo, maxBuffer: 1 << 24 })
    const lines = dirty.split('\n').filter(Boolean)
    if (lines.length) console.log(`  discarding ${lines.length} leftover change(s) from a previous run: ${lines.slice(0, 3).map((l) => l.slice(3)).join(', ')}${lines.length > 3 ? ' …' : ''}`)
    await exec('git', ['reset', '--hard', '--quiet', `origin/${base}`], { cwd: repo })
    await exec('git', ['clean', '-qfd'], { cwd: repo }).catch(() => {})
    const { stdout: at } = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo })
    console.log(`  reset to origin/${base} @ ${at.trim()}`)
  }
}

// ---- 2. lockfile agreement -------------------------------------------------------------------
const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
let matched = false, checked = false
for (const l of locks) {
  const a = sha(path.join(from, l)), b = sha(path.join(repo, l))
  if (!a && !b) continue
  checked = true
  if (a && b && a === b) { console.log(`  ${l} matches (${a})`); matched = true }
  else console.log(`  ${l} DIFFERS  reference ${a || 'absent'} vs worktree ${b || 'absent'}`)
}
if (!checked) console.log('  no lockfile found in either tree — cannot verify dependency agreement')

// ---- 3. node_modules -------------------------------------------------------------------------
const target = path.join(repo, 'node_modules')
const source = path.join(from, 'node_modules')

if (!fs.existsSync(source)) {
  console.error(`\n${from} has no node_modules to share. Install there first, or run npm ci inside ${repo}.`)
  process.exit(1)
}

const existing = fs.existsSync(target) || (() => { try { fs.lstatSync(target); return true } catch { return false } })()
if (existing) {
  const st = fs.lstatSync(target)
  if (st.isSymbolicLink()) console.log(`  node_modules -> ${fs.readlinkSync(target)}`)
  else console.log('  node_modules is a real directory (installed here) — leaving it alone')
} else if (!matched && checked) {
  console.log('\n  lockfiles differ — a symlink would give this worktree an INCOMPLETE node_modules,')
  console.log('  because the reference checkout was installed for a different dependency graph.')
  if (argv.includes('--install')) {
    console.log(`\n  running npm ci in ${repo} — this is slow (minutes) but it is one-time:\n`)
    const t0 = Date.now()
    await new Promise((resolve, reject) => {
      const { spawn } = require('node:child_process')
      const c = spawn('npm', ['ci'], { cwd: repo, stdio: 'inherit' })
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm ci exited ${code}`))))
      c.on('error', reject)
    })
    console.log(`\n  installed in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`)
  } else if (argv.includes('--force')) {
    fs.symlinkSync(source, target, 'dir')
    console.log('  node_modules linked anyway (--force) — expect missing-module errors')
  } else {
    console.error('\n  Pick one:')
    console.error(`    node bin/prepare-worktree.mjs --repo ${repo} --from ${from} --install`)
    console.error('        correct. npm ci in the worktree. ~2GB of disk, several minutes, one-time.')
    console.error(`    node bin/prepare-worktree.mjs --repo ${repo} --from ${from} --force`)
    console.error('        fast but wrong if the missing packages are ones the tests need.')
    process.exit(1)
  }
} else {
  fs.symlinkSync(source, target, 'dir')
  console.log(`  node_modules -> ${source}  (symlink, 0 bytes)`)
}

// ---- 4. prove nx can actually run ------------------------------------------------------------
const nxBin = path.join(repo, 'node_modules', '.bin', 'nx')
if (!fs.existsSync(nxBin)) {
  console.error('\nnx is still not resolvable in the worktree. Do not run baseline.mjs yet.')
  process.exit(1)
}
try {
  const { stdout } = await exec(nxBin, ['show', 'projects', '--json'], { cwd: repo, maxBuffer: 1 << 24 })
  console.log(`  nx works: ${JSON.parse(stdout).length} projects visible`)
} catch (e) {
  console.error(`\nnx is present but failed to run: ${String(e.message).slice(0, 200)}`)
  process.exit(1)
}

const { stdout: br } = await exec('git', ['branch', '--show-current'], { cwd: repo })
console.log(`\nready — ${repo} on ${br.trim() || '(detached)'}`)
console.log(`next: node bin/baseline.mjs --repo ${repo} --base ${base}\n`)
