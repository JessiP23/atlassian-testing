// The one node that writes code. Heavy tier (Opus 5).
//
// ARCHITECTURAL DECISION, stated here because it is the most consequential one in this repo:
// this node does NOT implement its own edit loop over the Converse API. It shells out to
// Claude Code in headless mode and lets IT own the inner loop — read file, edit, re-read, retry.
//
// Why: that inner loop is the single thing Cody's agent unambiguously got right. On ESI2-3376 it
// produced a correct two-layer fix, 6 test files, a `derive-import-failure-reason.ts` helper, and
// the string added to all 21 locale bundles — while keeping the technical cause in CloudWatch and
// the user-facing sentence in the table. Rebuilding that in LangChain tool-calling primitives is
// weeks of work to arrive somewhere worse. So:
//
//     LangGraph owns the PHASE boundaries  — durable, resumable, individually budgeted, traced.
//     Claude Code owns the INNER loop      — tool use, file edits, self-correction.
//
// Do not model tool calls as graph nodes. Every graph transition is a checkpoint write, and an
// agentic edit session is hundreds of tool calls.
//
// The invocation shape is copied from Cody's `lib-agent-core.sh:441` because it is proven on this
// machine, notably:
//   * `--max-budget-usd` — Claude Code enforces the per-node cap itself and exits when it hits it.
//     This is what produced `error_max_budget_usd` on ESI2-3376; here the cap is per NODE, so
//     hitting it fails one node instead of starving the run's only deliverable.
//   * `--output-format stream-json --verbose` — parseable cost and result, not scraped prose.
//   * `--strict-mcp-config` — the agent gets exactly the tools this phase needs and nothing else.

import { execFile } from 'node:child_process'
import { eslintCommand } from '../lib/lint.mjs'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { tierFor } from '../lib/models.mjs'
import { classify, overBudget, isDenied, isScratch } from '../lib/guard.mjs'
import { buildContextPack } from '../lib/contextpack.mjs'
import { runClaude } from '../lib/agent.mjs'

const exec = promisify(execFile)

const PROMPT = (s, ctx) => `You are fixing ${s.issueKey} in a checked-out worktree at ${s.repo}.

${ctx}

---


## Spec
${s.spec.summary}

## Acceptance criteria
${(s.spec.acceptanceCriteria || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}

## Non-goals — do not touch these
${(s.spec.nonGoals || []).map((a) => `- ${a}`).join('\n')}

## Plan
${(s.plan.steps || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}

## Files you may edit — this list is enforced mechanically
${s.plan.impactedFiles.map((f) => `- ${f}`).join('\n')}
${hypothesesBlock(s)}
Editing any other path will cause this run to be rejected and reverted.

If the fix genuinely requires a file not on this list, do NOT edit it and do NOT implement a
workaround inside the allowed files. STOP and write \`.pag/escalate.txt\`, whose FIRST line must be
exactly:

    NEED: <repo-relative path>[, <path>...]

listing every file you would need to edit, then a blank line, then your analysis: where the failure
actually originates (file:line), the control flow that proves the allowed files are not reached,
the root cause, and the fix you would make. That first line is parsed by the workflow, which will
re-plan with those files allowed and hand the work back to you — so name the files precisely and
name only what you need.

## Tests
${(s.plan.newTests || []).length
  ? (s.plan.newTests || []).map((t) => `- ${t.file} — pins: ${t.pins}`).join('\n')
  : `This repo has NO unit test runner — no jest, no vitest, no \`npm test\`. Do not add one, do not
add a test dependency, and do not spend time looking for a way to run unit tests: there isn't one,
and finding out costs minutes you need for the fix. The evidence for this ticket is the browser
witness above, which has already been written and proven red. Make it pass.`}

## Out of bounds
Everything under \`agent/\` is this workflow's own source, not part of the product. Do not read it,
do not edit it, do not copy its conventions. Nothing you need for this ticket is in there.
${s.repro?.status === 'red' ? `
## The reproducing test — READ-ONLY
\`${s.repro.file}\` already exists. It FAILS on the current code and encodes the bug exactly as the
ticket reports it. When you are done it must PASS, unchanged. You may not edit, rename, skip or
delete it — the workflow checks its hash and rejects the run if it changed. Run it with:
    ${s.repro.cmd}
Its current failure:
\`\`\`
${s.repro.redExcerpt || ''}
\`\`\`
` : ''}
${ctxPrior(s)}
## Order of work — the wall clock kills this session, unfinished work is carried forward as-is
1. The product fix, in the allowed files. 2. Make the reproducing test pass. 3. ONE focused test
of your own if the plan lists one. 4. lint the files you touched with exactly \`${eslintCommand(s.repo) || 'the project lint target'}\`
(that is the command this repo needs — do not go looking for the eslint config). Then stop. Do not
write more test files than the plan lists — a run died at the deadline writing its third.
Research is bounded: if after ~15 tool calls you have not made an edit, either edit the most likely
site or write \`.pag/escalate.txt\` naming the file the fix belongs in and stop — never keep reading.
Never run a project's whole test suite; run jest ONLY with --testPathPattern on the files you touch
(one full-suite run on CI ate 14 minutes and the entire patch budget).

## Standards — the gate enforces lint and types; you are responsible for these
- Match the neighbouring files in this package: naming, error handling, how they log, how they test.
- No new dependencies. No \`any\`, no \`@ts-ignore\`, no \`console.log\`, no commented-out code.
- Keep public signatures unless the plan says otherwise; if a caller listed under "Who calls these
  files" would break, stop and say so.
- Tests assert behaviour visible to the caller, not implementation details; one clear name per
  test that reads like the acceptance criterion.
- One short comment at the fix site referencing ${s.issueKey}, only where the code cannot explain itself.

## How to work

The context pack above is the result of a deterministic pass over the repo index: the target files
in full, everything that imports them, everything they import, the package's local conventions,
past tickets that touched them, and where their tests live. **It is already in your context.**
Re-deriving it with \`grep -rn\` / \`find\` across the monorepo costs real money and finds nothing new.
Read a specific file when the pack points you at one; do not sweep.

Write the code and the tests. Run only the tests you just wrote, to confirm they pass. Do NOT run
the repo-wide test suite (the workflow's verify step owns that, scoped), do not commit, and do not
create or switch branches — the workflow owns git. Leave everything uncommitted in the working tree.

## Your closing message — it becomes the reviewer's guide, so use exactly these headings
### Root cause
One or two sentences, with file:line, of what actually happens on the ticket's input.
### Why this fix
How the change works in plain English, and the alternatives you considered with one reason each for
not taking them (a different layer, a broader refactor, a guard at the call site…). "None considered" is
an acceptable answer only when the code offers no alternative — say so.
### Review first
The one or two file:line locations a reviewer should read first, and what to look for there.`

/** What the reproducing test settled, so the fix targets the mechanism that was demonstrated. */
function hypothesesBlock(s) {
  const hs = s.plan?.hypotheses || []
  if (!hs.length) return ''
  const held = hs.filter((h) => h.verdict === 'confirmed')
  const out = hs.filter((h) => h.verdict === 'rejected')
  const open = hs.filter((h) => !h.verdict)
  return `
## Which explanation the evidence supports
${held.length ? held.map((h) => `- ${h.id} HELD — ${h.statement} (${h.evidence || 'the reproducing test goes red on this mechanism'}). Fix THIS.`).join('\n') : '- none demonstrated yet: the plan\'s H1 is the working assumption, and the reproducing test is the evidence to make pass.'}
${out.map((h) => `- ${h.id} ruled out — ${h.statement}. Do not change code for it.`).join('\n')}
${open.map((h) => `- ${h.id} open [${h.checkable}] — ${h.statement}. Needs: ${h.check || 'data the run does not have'}. Do NOT fix it speculatively; the PR names it for a human.`).join('\n')}
`
}

/**
 * The newest earlier run on this ticket that left a diff: its product hunks and what became of it.
 * ESI2-3194 run 1 found the exact root cause and was refused on a scope technicality; run 2 began
 * from nothing and shipped logging. A diff is evidence about the code — judge it, do not redo it.
 */
function ctxPrior(s) {
  return ctxCarry(s) + ctxPriorRun(s)
}

// A prior fix that is a draft PR is not on the base: the reviewer will merge THIS PR, so this diff
// has to be in it. Reapply it (the files are in the allowed list), then fix the later defect on top.
function ctxCarry(s) {
  const carry = (s.spec?.carry || []).filter((c) => c.diff)
  if (!carry.length) return ''
  return carry.map((c) => `
## PR #${c.number} ("${c.title}") is ${c.state} and NOT merged — its change must be part of this fix
It addressed the first defect on this ticket; the customer's later report is a second one. Reapply
this change (adapted to the current tree, no need to be byte-identical), then fix the second defect.
\`\`\`diff
${c.diff}
\`\`\`
`).join('')
}

function ctxPriorRun(s) {
  const runDir = process.env.PAG_RUN_DIR
  if (!runDir) return ''
  const parent = path.dirname(path.resolve(runDir))
  let runs = []
  try { runs = fs.readdirSync(parent).filter((d) => d !== path.basename(runDir)).sort().reverse() } catch { return '' }
  for (const run of runs) {
    try {
      const dir = path.join(parent, run)
      const diff = fs.readFileSync(path.join(dir, 'patch.diff'), 'utf8')
      const hunks = diff.split(/^(?=diff --git |\n--- NEW FILE: )/m).filter((h) => h.trim() && !/\.(test|spec)\.[tj]sx?\b|__tests__\/|\/tests\//.test(h.split('\n')[0]))
      if (!hunks.length) continue
      const files = fs.readdirSync(dir)
      const refuse = files.find((f) => /-refuse\.json$/.test(f))
      const outcome = refuse
        ? (() => { const r = JSON.parse(fs.readFileSync(path.join(dir, refuse), 'utf8'))?.output?.refusal; return `refused for "${r?.reason}" (${String(r?.detail || '').slice(0, 160)})` })()
        : files.some((f) => /-publish\.json$/.test(f)) ? 'published as a draft PR (a reviewer has not accepted it)' : 'stopped before publishing'
      return `
## An earlier run on this ticket left this diff — ${outcome}
Judge it on its merits against the plan above. If its root cause is right, reapply it (adapted to
the allowed files) rather than re-deriving it; if it is wrong, say why in your closing report.
\`\`\`diff
${hunks.join('').slice(0, 10_000)}
\`\`\`
`
    } catch { /* incomplete run dir */ }
  }
  return ''
}

export function patchNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const tier = tierFor('patch')
    const allowance = budget.availableFor('patch')
    if (allowance <= 0.5) {
      return { refusal: { at: 'patch', reason: 'budget_exhausted', detail: `only $${allowance.toFixed(2)} left before the reserve` } }
    }

    const plannedTests = (s.plan.newTests || []).map((t) => t.file).filter(Boolean)
    // The frozen reproducing test ships in the PR, so it is in scope — but read-only (verify hashes it).
    // The frozen reproducing test, and — for the witness rung on a repo that can actually run
    // Playwright — the spec and fixtures reproduce COMMITTED into the repo so the reviewer gets the
    // test as code, not only as a screenshot. Both are read-only to this node (verify checks the
    // spec's hash), but both must be inside the allowlist or the guard reports the evidence itself
    // as scope creep.
    if (s.repro?.status === 'red' && s.repro.file) plannedTests.push(s.repro.file)
    for (const f of s.repro?.shipped || []) plannedTests.push(f)

    const timeMs = budget.timeFor('patch')
    if (timeMs < 2 * 60_000) {
      return { refusal: { at: 'patch', reason: 'time_budget', detail: `${(budget.timeLeftMs() / 1000).toFixed(0)}s of ${budget.maxMinutes} min left — not enough to write a patch` } }
    }

    fs.mkdirSync(path.join(s.repo, '.pag'), { recursive: true })
    const escalate = path.join(s.repo, '.pag/escalate.txt')
    if (fs.existsSync(escalate)) fs.unlinkSync(escalate)

    const { markdown: ctx, stats } = buildContextPack({ repo: s.repo, targets: s.plan.impactedFiles, issueKey: s.issueKey })
    onProgress(`context pack: ${stats.targets} targets, ${stats.importers} importers, ${stats.siblings} siblings, ${stats.precedent} precedents, ${stats.tests} existing tests (~${Math.round(ctx.length / 4)} tokens, $0)`)

    // Why --dangerously-skip-permissions and a git denylist (both set in lib/agent.mjs): the first
    // real run wasted six turns and part of $5.66 retrying `nx test`, `vitest`, `jest` and `tsc`,
    // then reported "every attempt to run tests was blocked by command approval in this
    // environment" — there is nobody to answer the prompt. Safe because the blast radius is bounded
    // by construction: a disposable worktree, git denied at the tool layer, the real diff checked
    // against the plan's allowlist afterwards, and now a wall-clock kill.
    // A session that spends NOTHING and writes NO product file did not run. Claude Code exits 0 with
    // subtype `success` when Bedrock refuses it — ESI2-3437 on 2026-09-11 burned 240s on
    // "API Error: 503 … try again in a moment", reported success at $0.0000, and the run went on to
    // verify, found the repro still red, and handed over an empty diff as if the fix had failed on
    // its merits. Cost is the tell: a real edit session always spends. One retry, then the truth.
    let { code, cost, subtype, text: report } = await runClaude({
      cwd: s.repo, prompt: PROMPT(s, ctx), model: tier.model, budgetUsd: allowance, timeoutMs: timeMs, onProgress,
    })
    budget.charge('patch', cost, { model: tier.model, subtype, exit: code })

    const readOnly = new Set(plannedTests)
    const productEdits = async () => (await exec('git', ['diff', '--name-only', 'HEAD'], { cwd: s.repo, maxBuffer: 1 << 24 }))
      .stdout.split('\n').map((x) => x.trim()).filter(Boolean).filter((f) => !readOnly.has(f) && !isScratch(f))

    if (cost === 0 && !(await productEdits()).length) {
      const why = (String(report).match(/API Error: \d{3}[^\n]*/) || [])[0] || `${subtype || 'exit ' + code} with no spend`
      const again = budget.timeFor('patch')
      if (again < 2 * 60_000) {
        return { refusal: { at: 'patch', reason: 'provider_unavailable', detail: `the model provider refused the patch session (${why}) and there is no time left to retry` } }
      }
      onProgress(`the patch session spent $0 and changed no product file — the provider refused it (${why}). Retrying once.`)
      await new Promise((r) => setTimeout(r, 20_000));
      ({ code, cost, subtype, text: report } = await runClaude({
        cwd: s.repo, prompt: PROMPT(s, ctx), model: tier.model, budgetUsd: budget.availableFor('patch'), timeoutMs: again, onProgress,
      }))
      budget.charge('patch', cost, { model: tier.model, subtype, exit: code, retry: 1 })
      if (cost === 0 && !(await productEdits()).length) {
        return { refusal: { at: 'patch', reason: 'provider_unavailable', detail: `two patch sessions were refused by the model provider (${why}). Nothing is wrong with the ticket or the plan — re-run it.` } }
      }
    }

    if (fs.existsSync(escalate)) {
      const text = fs.readFileSync(escalate, 'utf8').trim()

      // Extract the files it needs, consistently, whatever the ticket. The NEED: header is the
      // contract; the prose scan is a fallback so a run is not thrown away just because the model
      // put the path in a sentence instead (which is what happened on ESI2-3379).
      const PATH = /\b(packages\/[\w./@-]+\.[a-z]{2,4})\b/g
      const header = text.match(/^\s*NEED:\s*(.+)$/m)
      let wanted
      if (header) {
        wanted = header[1].split(/[,\s]+/).map((x) => x.trim().replace(/^[`'"]|[`'",.]$/g, '')).filter(Boolean)
      } else {
        // No header. An escalation names many files while EXPLAINING and only one or two that it
        // would edit, so look for editing intent first — a blind path sweep would widen the plan
        // to every file it happened to cite.
        const intent = [...text.matchAll(/(?:requires? editing|needs? editing|must edit|belongs in|should be (?:edited|changed)|fix (?:goes|belongs) in)\s*:?\s*([\s\S]{0,240})/gi)]
          .flatMap((m) => [...m[1].matchAll(PATH)].map((x) => x[1]))
        wanted = intent.length ? intent : [...text.matchAll(PATH)].map((m) => m[1]).slice(0, 2)
      }

      // Only files that actually exist, are not on the DENY list, and are not already allowed.
      const already = new Set([...s.plan.impactedFiles, ...plannedTests])
      const neededFiles = [...new Set(wanted)]
        .filter((f) => !already.has(f))
        .filter((f) => !isDenied(f))
        .filter((f) => { try { return fs.statSync(path.join(s.repo, f)).isFile() } catch { return false } })
        .slice(0, 4)

      onProgress(`escalated: needs ${neededFiles.length ? neededFiles.join(', ') : '(no usable path named)'}`)
      return { escalation: { text, neededFiles }, refusal: null }
    }
    // ---- Enforce the contract on the REAL diff, not on the model's word ----------------------
    const { stdout: names } = await exec('git', ['diff', '--name-only', 'HEAD'], { cwd: s.repo, maxBuffer: 1 << 24 })
    const { stdout: untracked } = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: s.repo, maxBuffer: 1 << 24 })
    const changed = [...new Set([...names.split('\n'), ...untracked.split('\n')].map((x) => x.trim()).filter(Boolean))]
      .filter((p) => !isScratch(p))

    // Persist the diff NOW, before any guard can refuse and before the next run resets the
    // worktree. A dry run exists so you can read the diff; losing it defeats the exercise.
    try {
      const runDir = process.env.PAG_RUN_DIR
      if (runDir) {
        const { stdout: full } = await exec('git', ['diff', 'HEAD'], { cwd: s.repo, maxBuffer: 1 << 26 })
        const untrackedBodies = (await Promise.all(changed
          .filter((f) => !full.includes(`b/${f}`))
          .map(async (f) => {
            try { return `\n--- NEW FILE: ${f}\n${fs.readFileSync(path.join(s.repo, f), 'utf8')}` } catch { return '' }
          }))).join('')
        fs.writeFileSync(path.join(runDir, 'patch.diff'), full + untrackedBodies)
        onProgress(`diff saved to ${path.join(runDir, 'patch.diff')}`)
      }
    } catch { /* never fail a run over bookkeeping */ }

    // ---- did the session finish, and does it matter? -----------------------------------------
    //
    // KAN-11: the patch session hit its 420s wall-clock kill having already written
    // `app/api/assets/route.ts`, a rewritten `app/page.tsx` and a test file — and the run REFUSED,
    // so all of it was deleted. That is the exact loss the hand-over path was built to stop, and it
    // was only ever wired to the verify->repair edge; a patch that ran out of clock had no way out.
    //
    // A timeout is not a verdict on the work. It says the session stopped, not that what it wrote
    // is wrong. So when there IS a diff, the run continues into `verify`, where the whole safety
    // chain still applies unchanged: the path guard, the secret scan, the frozen witness, the gate.
    // If the partial work is good, it publishes. If it is half-written it fails the gate and
    // becomes an INCOMPLETE draft a human can finish. Either beats deleting it.
    //
    // With no diff there is genuinely nothing to carry forward, and that is still a refusal.
    if (code !== 0 && subtype !== 'success') {
      if (!changed.length) {
        return { refusal: { at: 'patch', reason: subtype || `exit_${code}`, detail: 'the patch session did not complete and wrote nothing' } }
      }
      onProgress(`patch ${subtype || `exit_${code}`} after ${(budget.report().phases.at(-1)?.ms ?? 0) / 1000 | 0}s, but ${changed.length} file(s) were written — carrying them into verify rather than discarding them`)
    }

    const verdict = classify(changed, s.plan.impactedFiles, plannedTests)

    if (verdict.denied.length) {
      // Non-negotiable. This is the .env class — the exact failure that would have pushed five
      // live credentials to GitHub on ESI2-3376. Revert those paths and refuse.
      await exec('git', ['checkout', '--', ...verdict.denied], { cwd: s.repo }).catch(() => {})
      return {
        changed,
        refusal: { at: 'patch', reason: 'touched_denied_path', detail: `reverted and refused: ${verdict.denied.join(', ')}` },
      }
    }

    const { stdout: stat } = await exec('git', ['diff', '--shortstat', 'HEAD'], { cwd: s.repo })
    const m = stat.match(/(\d+) files? changed(?:, (\d+) insertions?)?(?:[^,]*, (\d+) deletions?)?/) || []
    const diffStat = { files: changed.length, insertions: Number(m[2] || 0), deletions: Number(m[3] || 0) }

    const over = overBudget(diffStat)
    if (over.length || verdict.outOfScope.length) {
      return {
        changed, diffStat,
        refusal: {
          at: 'patch',
          reason: 'scope_creep',
          detail: [
            ...over,
            verdict.outOfScope.length ? `outside the plan's impactedFiles: ${verdict.outOfScope.join(', ')}` : '',
          ].filter(Boolean).join('; '),
        },
      }
    }

    // The session's closing message is its own account of the root cause and the change. It is the
    // only place that story exists — the plan predates the code and publish must not paraphrase a
    // plan as if it were the diff (ESI2-3406 r8/r9: the PR cited a missing validateAccess call that
    // was never missing).
    return { changed, diffStat, attempts: 0, patchReport: String(report || '').slice(0, 6000) }
  }
}
