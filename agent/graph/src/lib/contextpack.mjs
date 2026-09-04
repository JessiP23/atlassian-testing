// The context pack. Everything the patch node needs to fix a bug WITHOUT exploring the repo.
//
// This is the answer to "the coding agent should not spend a long time in the code". On
// ESI2-3376 Opus 5 opened with `grep -rn "templateId"`, four `find` sweeps and two more greps
// before it read a relevant file — roughly a third of a $4.54 phase spent rediscovering things
// the index already knows. Everything assembled here is derived from `.par/index.json` and
// `.par/history.json`, so it is deterministic, free, and takes milliseconds.
//
// Six kinds of context, each answering a question the agent would otherwise ask by grepping:
//
//   1. TARGETS       "what am I changing?"          the plan's files, full text (bounded)
//   2. IMPORTERS     "who calls this?"              reverse import edges — the blast radius
//   3. DEPENDENCIES  "what does it rely on?"        forward import edges, signatures only
//   4. SIBLINGS      "what are the local idioms?"   same-package neighbours, exports only
//   5. PRECEDENT     "how has this been changed?"   past tickets that touched these files
//   6. TESTS         "where do tests for this go?"  existing spec files beside the targets
//
// PRECEDENT is the one that is genuinely hard to get any other way and cheap for us: 1,796 mined
// tickets with their real changed-file lists. "This file was last touched for ESI2-2841, which was
// about import template routing" is the kind of thing an engineer knows and an agent cannot grep.
//
// Everything is size-capped. A context pack that grows without bound is just the repo again.

import fs from 'node:fs'
import path from 'node:path'
import { buildGraph } from '../../../src/router.mjs'

const CAPS = {
  // TOTAL line budget across all targets, not per-target. The first real run planned 8 files and
  // the pack came to ~21,000 tokens — 8 x 500 lines. That is most of a phase's cost spent on
  // context before a single edit. Budget the whole pack and divide it.
  totalLines: Number(process.env.PAG_CTX_TOTAL_LINES || 1800),
  maxTargets: Number(process.env.PAG_CTX_MAX_TARGETS || 6),
  targetLines: Number(process.env.PAG_CTX_TARGET_LINES || 500),
  importers: Number(process.env.PAG_CTX_IMPORTERS || 12),
  siblings: Number(process.env.PAG_CTX_SIBLINGS || 15),
  precedent: Number(process.env.PAG_CTX_PRECEDENT || 6),
}

let cache = null

/** Load the index + history once per process and derive the directed import graph. */
// Default: agent/.par — the index and history the refresher builds for THIS repo.
export function loadIndex(parDir = process.env.PAG_PAR_DIR || path.resolve(import.meta.dirname, '../../../.par')) {
  if (cache && cache.parDir === parDir) return cache

  const index = JSON.parse(fs.readFileSync(path.join(parDir, 'index.json'), 'utf8'))
  const history = fs.existsSync(path.join(parDir, 'history.json'))
    ? JSON.parse(fs.readFileSync(path.join(parDir, 'history.json'), 'utf8'))
    : []

  const g = buildGraph(index.files)

  // Directed edges. The router's adjacency is undirected because it wants "near"; we need
  // "depends on" vs "depended on by", because those answer different questions for a patch.
  const importsOf = new Map()   // path -> [paths it imports]
  const importedBy = new Map()  // path -> [paths that import it]
  for (const f of index.files) {
    const out = []
    for (const spec of f.imports) {
      const hit = g.resolve(f.path, spec)
      if (!hit || hit === f.path) continue
      out.push(hit)
      if (!importedBy.has(hit)) importedBy.set(hit, [])
      importedBy.get(hit).push(f.path)
    }
    importsOf.set(f.path, out)
  }

  // path -> tickets that changed it, newest first.
  const touchedBy = new Map()
  for (const t of history) {
    for (const f of t.files || []) {
      if (!touchedBy.has(f)) touchedBy.set(f, [])
      touchedBy.get(f).push(t)
    }
  }
  for (const list of touchedBy.values()) list.sort((a, b) => String(b.date).localeCompare(String(a.date)))

  // package -> its files, for the siblings section.
  const byPkg = new Map()
  for (const f of index.files) {
    if (!byPkg.has(f.pkg)) byPkg.set(f.pkg, [])
    byPkg.get(f.pkg).push(f)
  }

  cache = { parDir, index, byPath: g.byPath, importsOf, importedBy, touchedBy, byPkg, staleness: index.builtAt }
  return cache
}

const readClipped = (repo, p, maxLines) => {
  let text
  try { text = fs.readFileSync(path.join(repo, p), 'utf8') } catch { return null }
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines — read the file if you need them`].join('\n')
}

/**
 * Build the markdown context pack for a set of target files.
 * @returns {{ markdown:string, stats:object }}
 */
export function buildContextPack({ repo, targets, issueKey }) {
  const ix = loadIndex()
  const out = []
  const seen = new Set(targets)
  const stats = { targets: targets.length, importers: 0, siblings: 0, precedent: 0, tests: 0 }

  out.push(`# Context pack — ${issueKey}`)
  out.push('')
  out.push(`Assembled from the repo index built at ${ix.staleness} (commit ${ix.index.commit?.slice(0, 7) || 'unknown'}).`)
  out.push('Everything below is already loaded. **Do not grep or find to rediscover it.**')
  out.push('')

  // ---- 1. targets ---------------------------------------------------------------------------
  out.push('## Files you are changing')
  // Per-target share of the total budget, floored so a large plan still shows each file's head.
  const perTarget = Math.max(120, Math.min(CAPS.targetLines, Math.floor(CAPS.totalLines / Math.max(1, targets.length))))
  if (targets.length > CAPS.maxTargets) {
    out.push('')
    out.push(`> ${targets.length} target files — more than the usual ${CAPS.maxTargets}. Each is clipped to ${perTarget} lines.`)
    out.push('> A change this wide is usually a sign the plan should have been narrower.')
  }
  for (const p of targets) {
    const rec = ix.byPath.get(p)
    const body = readClipped(repo, p, perTarget)
    out.push('')
    out.push(`### ${p}`)
    out.push(`package \`${rec?.pkg || '?'}\` · exports: ${(rec?.exports || []).join(', ') || '(none)'} · ${rec?.loc ?? '?'} loc`)
    out.push('')
    out.push('```ts')
    out.push(body ?? '(file does not exist yet — you are creating it)')
    out.push('```')
  }

  // ---- 2. importers: the blast radius -------------------------------------------------------
  const importers = new Map()
  for (const p of targets) for (const imp of (ix.importedBy.get(p) || [])) {
    if (!seen.has(imp)) importers.set(imp, [...(importers.get(imp) || []), p])
  }
  const importerList = [...importers.entries()].slice(0, CAPS.importers)
  stats.importers = importerList.length
  if (importerList.length) {
    out.push('')
    out.push('## Who calls these files (blast radius)')
    out.push('Change a signature here and these break. Listed with what they import from your targets.')
    out.push('')
    for (const [p, via] of importerList) {
      const rec = ix.byPath.get(p)
      out.push(`- \`${p}\` (${rec?.pkg}) — imports ${via.map((v) => path.basename(v)).join(', ')}`)
    }
    const extra = importers.size - importerList.length
    if (extra > 0) out.push(`- … and ${extra} more importers not listed`)
  }

  // ---- 3. dependencies ----------------------------------------------------------------------
  const deps = new Set()
  for (const p of targets) for (const d of (ix.importsOf.get(p) || [])) if (!seen.has(d)) deps.add(d)
  if (deps.size) {
    out.push('')
    out.push('## What your targets depend on')
    out.push('Exported names only — read the file if you need a body.')
    out.push('')
    for (const d of [...deps].slice(0, 20)) {
      const rec = ix.byPath.get(d)
      out.push(`- \`${d}\` → ${(rec?.exports || []).slice(0, 8).join(', ') || '(no named exports)'}`)
    }
  }

  // ---- 4. siblings: local idiom -------------------------------------------------------------
  // Config, barrels and generated files teach nothing about local idiom and crowd out files that
  // do, so they are excluded rather than capped away.
  const NOISE = /(jest|vite|tailwind|eslint|tsup|webpack)\.config\.[tj]s$|\/index\.ts$|\/main\.ts$|\.d\.ts$|\/fields\.ts$/
  const pkgs = [...new Set(targets.map((p) => ix.byPath.get(p)?.pkg).filter(Boolean))]
  const sibs = []
  for (const pkg of pkgs) {
    for (const f of (ix.byPkg.get(pkg) || [])) {
      if (seen.has(f.path) || deps.has(f.path) || importers.has(f.path)) continue
      if (NOISE.test(f.path) || /\.(test|spec)\./.test(f.path)) continue
      sibs.push(f)
    }
  }
  // Prefer the files closest to the targets in the directory tree — same folder first.
  const depthOf = (p) => p.split('/').length
  const nearTarget = (p) => Math.min(...targets.map((t) => {
    const a = t.split('/'), b = p.split('/')
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++
    return depthOf(t) + depthOf(p) - 2 * i
  }))
  sibs.sort((a, b) => nearTarget(a.path) - nearTarget(b.path))
  const sibList = sibs.slice(0, CAPS.siblings)
  stats.siblings = sibList.length
  if (sibList.length) {
    out.push('')
    out.push(`## Neighbours in the same package${pkgs.length > 1 ? 's' : ''} (${pkgs.join(', ')})`)
    out.push('Follow the conventions these already use — naming, error handling, module shape.')
    out.push('')
    for (const f of sibList) out.push(`- \`${f.path}\` → ${(f.exports || []).slice(0, 6).join(', ') || '—'}`)
  }

  // ---- 5. precedent: how these files have been changed before --------------------------------
  const prec = new Map()
  for (const p of targets) for (const t of (ix.touchedBy.get(p) || []).slice(0, CAPS.precedent)) {
    if (!prec.has(t.key)) prec.set(t.key, { ...t, hit: [] })
    prec.get(t.key).hit.push(p)
  }
  const precList = [...prec.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, CAPS.precedent)
  stats.precedent = precList.length
  if (precList.length) {
    out.push('')
    out.push('## Precedent — past tickets that changed these files')
    out.push('Mined from merged PRs. Useful for spotting a fix that was already attempted, or a')
    out.push('convention the team settled on. Not authoritative; the code is.')
    out.push('')
    for (const t of precList) {
      out.push(`- **${t.key}** (${t.date}) — ${String(t.text || '').slice(0, 160)}`)
      out.push(`  touched: ${t.hit.map((h) => path.basename(h)).join(', ')} (+${(t.files?.length || 1) - t.hit.length} other files)`)
    }
  }

  // ---- 6. tests -----------------------------------------------------------------------------
  const tests = []
  for (const p of targets) {
    const base = p.replace(/\.[^.]+$/, '')
    const ext = path.extname(p)
    for (const cand of [`${base}.test${ext}`, `${base}.spec${ext}`]) {
      if (ix.byPath.has(cand) || fs.existsSync(path.join(repo, cand))) tests.push({ target: p, test: cand })
    }
  }
  stats.tests = tests.length
  out.push('')
  out.push('## Tests')
  if (tests.length) {
    out.push('These already exist and are where your regression test belongs — extend, do not replace:')
    out.push('')
    for (const { target, test } of tests) out.push(`- \`${test}\` covers \`${path.basename(target)}\``)
  } else {
    out.push('No test file exists beside any target. Create one at `<target>.test.<ext>`, matching')
    out.push('the convention used by the package neighbours listed above.')
  }
  const untested = targets.filter((p) => !tests.some((t) => t.target === p) && !/\.(test|spec)\./.test(p))
  if (tests.length && untested.length) {
    out.push('')
    out.push(`No existing test for: ${untested.map((p) => `\`${p}\``).join(', ')}`)
  }

  return { markdown: out.join('\n'), stats }
}
