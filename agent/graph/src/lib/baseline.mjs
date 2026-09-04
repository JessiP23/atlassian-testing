// Baseline failure snapshot + diff. The second half of the ESI2-3376 fix.
//
// Cody solved this with a hand-maintained markdown file (`known-baseline-failures.md`) that the
// PROMPT tells the model to consult. That was a real insight — it is the reason his agent doesn't
// re-derive the same 133 failures every run — but it has two defects:
//
//   * it is prose, so the gate cannot act on it. Only the model can, and only if it reads and
//     believes it. On ESI2-3376 the failures still reached the operator as raw error text.
//   * it goes stale silently. It was "Recorded 2026-07-31 from live run evidence". Nothing
//     re-derives it, so a newly-broken main looks like an agent regression forever after.
//
// So: same idea, mechanised. Run the gate ONCE on a clean checkout of the base branch, store the
// set of failing test ids as JSON keyed by the base commit, and afterwards a run's verdict is
//
//     new_failures = failures(patched) \ failures(baseline)
//
// If that set is empty the patch is green even when 133 tests are red, and the operator is told
// "133 pre-existing failures ignored (baseline abc1234)" instead of a wall of stack traces.
//
// Snapshot cost is one full gate run per base commit, amortised over every ticket on that commit.
// It refreshes automatically when the base moves, which is the property the markdown file lacked.

import fs from 'node:fs'
import path from 'node:path'

const DIR = process.env.PAG_BASELINE_DIR || '.baseline'

/**
 * Parse jest/vitest output into stable failure ids.
 * `● Suite › nested › case` (jest) and `✗/× path > case` (vitest) both appear in this monorepo.
 */
export function parseFailures(output) {
  const ids = new Set()
  for (const line of output.split('\n')) {
    // jest failure header: "  ● QueryBuilder › #convert › gt › is supported"
    let m = line.match(/^\s*\u25cf\s+(.+?)\s*$/)
    if (m && !/^Console/.test(m[1])) { ids.add(norm(m[1])); continue }
    // vitest: "  \u00d7 src/foo.test.ts > does a thing 12ms"
    m = line.match(/^\s*[\u2717\u00d7]\s+(.+?)\s*$/)
    if (m) { ids.add(norm(m[1])); continue }
    // suite-level, both runners: "FAIL packages/.../foo.spec.ts"
    m = line.match(/^\s*FAIL\s+(?:\S+\s+)?(\S+\.(?:spec|test)\.[tj]sx?)/)
    if (m) { ids.add(norm(`FAIL ${m[1]}`)); continue }
  }
  ids.delete('')
  return ids
}

const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\d+(\.\d+)?\s*m?s\)/g, '').trim()

/**
 * Parse nx's own failure summary into `project:target` ids.
 *
 * This is the ROBUST signal and it is why the first two baseline attempts recorded zero. `nx
 * run-many` prints a summary block and, depending on output style, may print NO per-test output at
 * all — so a parser looking only for jest/vitest `●` lines finds nothing and concludes "green".
 * nx always prints this block:
 *
 *     NX   Running target test for 223 projects failed
 *     Failed tasks:
 *       - lambdas-libs-common:test
 *       - apis-rest:test
 *
 * Task granularity is coarser than test granularity, but it is available unconditionally and it is
 * still the right comparison: if `apis-rest:test` was red on the base commit and is red now, the
 * patch did not break it.
 */
export function parseFailedTasks(output) {
  const ids = new Set()
  // The summary block, when present.
  const block = output.split(/Failed tasks:/).slice(1).join('\n')
  for (const m of block.matchAll(/^\s*[-*]\s*([\w@/.-]+:[\w:.-]+)\s*$/gm)) ids.add(m[1])
  // Per-task failure lines, whatever the output style.
  for (const m of output.matchAll(/^\s*(?:\u2716|x|✗)?\s*nx run ([\w@/.-]+:[\w:.-]+).*?(?:failed|exited with)/gim)) ids.add(m[1])
  for (const m of output.matchAll(/Running target \S+ for project ([\w@/.-]+) failed/g)) ids.add(`${m[1]}:test`)
  return ids
}

const file = (baseSha) => path.join(DIR, `${baseSha}.json`)

export function has(baseSha) {
  return fs.existsSync(file(baseSha))
}

export function save(baseSha, failures, meta = {}, tasks = new Set()) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(
    file(baseSha),
    JSON.stringify({
      baseSha,
      recordedAt: new Date().toISOString(),
      ...meta,
      failedTasks: [...tasks].sort(),   // coarse, always available
      failures: [...failures].sort(),   // fine, only when per-test output was captured
    }, null, 2)
  )
}

export function load(baseSha) {
  if (!has(baseSha)) return null
  const d = JSON.parse(fs.readFileSync(file(baseSha), 'utf8'))
  return new Set(d.failures || [])
}

export function loadTasks(baseSha) {
  if (!has(baseSha)) return null
  const d = JSON.parse(fs.readFileSync(file(baseSha), 'utf8'))
  return new Set(d.failedTasks || [])
}

/**
 * The verdict. `newFailures` is the ONLY thing that should ever gate a PR.
 *
 * @param {string} output   combined stdout+stderr of the scoped gate
 * @param {Set<string>|null} baseline
 */
export function verdict(output, baseline, baselineTasks = null) {
  const observed = parseFailures(output)
  const observedTasks = parseFailedTasks(output)

  if (!baseline && !baselineTasks) {
    // No snapshot: we cannot attribute. Report honestly rather than guessing either way.
    return { attributable: false, observed: [...observed], observedTasks: [...observedTasks], newFailures: [...observed], newTasks: [...observedTasks], preExisting: [] }
  }

  const b = baseline || new Set()
  const bt = baselineTasks || new Set()
  const newFailures = [...observed].filter((id) => !b.has(id))
  const preExisting = [...observed].filter((id) => b.has(id))
  const newTasks = [...observedTasks].filter((id) => !bt.has(id))
  const preExistingTasks = [...observedTasks].filter((id) => bt.has(id))

  return { attributable: true, observed: [...observed], observedTasks: [...observedTasks], newFailures, preExisting, newTasks, preExistingTasks }
}

/** One-line operator summary. This is what replaces the wall of stack traces. */
export function summarise(v, baseSha) {
  const sha = baseSha.slice(0, 7)
  if (!v.attributable) {
    return `${v.observedTasks.length} failing task(s) — NO baseline for ${sha}, cannot attribute. Snapshot first.`
  }
  // A NEW failing TASK is a regression even when no per-test line was captured, so it gates first.
  if (v.newTasks?.length) {
    return `${v.newTasks.length} NEW failing task(s): ${v.newTasks.slice(0, 5).join(', ')}` +
           `${v.newFailures.length ? ` — ${v.newFailures.length} new test(s)` : ''}` +
           ` (${v.preExistingTasks?.length || 0} pre-existing task(s) ignored)`
  }
  if (v.newFailures.length) {
    return `${v.newFailures.length} NEW failure(s) caused by this patch (${v.preExisting.length} pre-existing ignored)`
  }
  const ignored = (v.preExistingTasks?.length || 0)
  return `green — ${ignored} pre-existing failing task(s) and ${v.preExisting.length} pre-existing test(s) ignored (baseline ${sha})`
}
