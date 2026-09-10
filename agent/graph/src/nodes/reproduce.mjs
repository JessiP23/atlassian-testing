// The reproducing test. Written BEFORE the patch, proven RED on the pinned commit, then frozen.
//
// Why this node exists: the gate proves "no new failures in the owning projects", not "the
// reported bug is fixed". SWT-Bench measured that filtering patches through a test that fails
// before and passes after DOUBLES precision; Google's agent went 57% -> 74% human-rated plausible
// with one. This is the single highest-value quality step available, and it costs one bounded
// Claude Code session.
//
// How the test is written — pass-first, then invert (AssertFlip, 2025: 43.6% fail-to-pass this
// way vs 24.2% asking for a failing test directly). Step 1 writes a test that PASSES on the buggy
// code and encodes the wrong behaviour the ticket reports; that it passes proves the imports,
// mocks and harness work. Step 2 flips the assertion to the expected behaviour; that it now FAILS
// proves it reproduces the bug and nothing else. The workflow re-runs the spec itself afterwards —
// the model's word that it is red is not the evidence, the runner's output is.
//
// Frozen: the file's sha256 is recorded here; verify refuses `repro_tampered` if patch touched it.
// That is what stops a green run from being green because the test was edited (AgentLens: ~1 in 10
// green patches passes for the wrong reason).
//
// Degrades honestly: no reproducible test after PAG_REPRO_ATTEMPTS means `status: 'none'` with a
// reason. The run continues — under half of real issues are reproducible even for the best
// methods — and the PR says so in its first line so the reviewer reads harder.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { tierFor } from '../lib/models.mjs'
import { runClaude } from '../lib/agent.mjs'
import { reproPathFor, reproCommand, runSpec, sha256, saveEvidence, excerpt } from '../lib/repro.mjs'
import { parseGateFailures, formatFailures } from '../lib/gatelog.mjs'
import { loadProfile } from '../../profiles/index.mjs'
import { isTestFile } from '../lib/guard.mjs'

const exec = promisify(execFile)
const ATTEMPTS = Number(process.env.PAG_REPRO_ATTEMPTS || 2)
const REPRO_BUDGET = Number(process.env.PAG_REPRO_BUDGET || 1.5)
// This phase's clock is now ONE number owned by lib/budget.mjs (PHASES.reproduce), not a second
// ceiling maintained here. On KAN-6 the witness iterated for 566s of a 1200s run (oklch colours,
// then per-assertion timeouts) and left repair 149s, which is not enough to fix anything.
// budget.timeFor('reproduce') is min(its own ceiling, what is left after patch/verify/publish are
// reserved), so it can never eat the deliverable — and the two attempts share it rather than each
// getting the whole thing.
// The phase ceiling is a TOTAL across both attempts, not a fresh allowance per attempt — see
// Budget.phaseTimeFor. KAN-11 overran 360s -> 553s because this used to recompute from the run's
// remaining clock, and the overrun was taken out of `patch`.
// How many attempts the phase can still afford. Below 2x the minimum it is one attempt or none:
// two 75s attempts at a component test both die mid-file; one 150s attempt can finish.
const MIN_ATTEMPT_MS = Number(process.env.PAG_MIN_ATTEMPT_MS || 120_000)
const attemptsFor = (budget) => (budget.phaseTimeFor('reproduce', 1) >= 2 * MIN_ATTEMPT_MS ? ATTEMPTS : 1)
const attemptShare = (budget, attempt, attempts = ATTEMPTS) => budget.phaseTimeFor('reproduce', attempts - attempt + 1)


/**
 * Read `REPRO: red H2 ruled-out: H1, H3` from the session's closing text and stamp verdicts on the
 * plan's hypotheses. A red with no id names H1 (the test was told to start there). Ids the plan does
 * not know are ignored; a "data"/"browser" hypothesis can never be held by a unit test.
 */
export function hypothesisVerdicts(hypotheses, text, specFile) {
  if (!hypotheses?.length) return { held: null, hypotheses: null, note: '' }
  const line = (String(text || '').match(/REPRO:\s*red[^\n]*/i) || [''])[0]
  const heldId = (line.match(/red\s+(H\d+)/i) || [])[1]?.toUpperCase() || 'H1'
  const ruled = [...line.matchAll(/ruled-?out:?\s*((?:H\d+[,\s]*)+)/gi)].flatMap((m) => m[1].match(/H\d+/gi) || []).map((x) => x.toUpperCase())
  const ids = new Set(hypotheses.map((h) => h.id))
  const held = ids.has(heldId) && hypotheses.find((h) => h.id === heldId).checkable === 'test' ? heldId : null
  const out = hypotheses.map((h) => {
    if (h.id === held) return { ...h, verdict: 'confirmed', evidence: `${specFile} fails on the unpatched code with this mechanism` }
    if (ruled.includes(h.id) && h.checkable === 'test') return { ...h, verdict: 'rejected', evidence: 'its check passed on the unpatched code' }
    return h
  })
  const note = held ? `hypothesis ${held} held${ruled.length ? `; ruled out ${ruled.filter((x) => ids.has(x)).join(', ')}` : ''}` : 'red test did not name a plan hypothesis'
  return { held, hypotheses: out, note }
}

const PROMPT = (s, { specFile, cmd, rung, previous }) => `You are writing a REPRODUCING TEST for ${s.issueKey} in the worktree at ${s.repo}.
You are NOT fixing the bug. The code stays exactly as it is; you add one test file that proves the
bug exists. A separate step will fix the code afterwards and your test must then pass unchanged.

## The bug, from the ticket
${s.spec.summary}
${s.spec.symptom?.screen ? `
## The symptom, exactly as reported
- Screen: ${s.spec.symptom.screen}
- Error text: ${s.spec.symptom.errorText || '(no error shown — a wrong value or a missing element)'}
- Values involved: ${(s.spec.symptom.inputs || []).join(', ') || '(none given)'}
- Likely layer: ${s.spec.symptom.layer || 'unknown'}${s.spec.symptom.why ? ` — ${s.spec.symptom.why}` : ''}
` : ''}
## Acceptance criteria (the EXPECTED behaviour)
${(s.spec.acceptanceCriteria || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}

## Where the plan says the fix will go (read these to know what to exercise)
${s.plan.impactedFiles.map((f) => `- ${f}`).join('\n')}
${(s.plan.hypotheses || []).length ? `
## Competing explanations — your test decides between them
${s.plan.hypotheses.map((h) => `- ${h.id} [${h.checkable}]: ${h.statement}\n    check: ${h.check}`).join('\n')}
Encode the FIRST hypothesis whose checkable is "test" as your test. If its check PASSES on the unpatched
code (the mechanism is not what happens), that hypothesis is ruled out: move to the next "test" one and
say so. Never write a test for a "data" or "browser" hypothesis — you do not have what it needs.
Your final line names the outcome: \`REPRO: red H2\` (H2's check went red), and if you ruled any out,
add \`ruled-out: H1\` on the same line, e.g. \`REPRO: red H2 ruled-out: H1\`.
` : ''}
## The plan can be wrong, and you are the first step that reads the code
Before writing anything, trace how THESE files produce the symptom on THAT screen for THOSE values.
If they do not — the error text is built elsewhere, the values never reach this code, the screen is
rendered by a different layer — do not write a test here. Answer instead with one line:
    REPRO: wrong-location <path/to/the/file/that/actually/produces/it> <one sentence why>
naming a file that EXISTS in this repo. The plan is redone around that file. A red test against the
wrong file is worse than no test: it turns green when the wrong file is patched.

## The ONE file you may create — exactly this path, nothing else
    ${specFile}
${rung === 'component' ? `
This is a web-app target. Use React Testing Library (@testing-library/react + @testing-library/user-event,
both already installed): render the component, drive it the way the ticket describes, assert what
the user sees or what handler/mutation is called. jsdom cannot measure layout — do not assert CSS.` : `
Use jest with the owning project's existing config. Follow the conventions of the nearest existing
spec file (imports, mocks, describe/it naming).`}

## Run it with exactly this command
    ${cmd}

## Protocol — pass first, then invert
1. Write ONE test whose name reads like the ticket's symptom, e.g. "update-import error row keeps
   the Asset ID column". Make its assertion describe the CURRENT (wrong) behaviour, so it PASSES on
   this unpatched code. Run the command. It must pass — this proves the harness, imports and mocks
   are right. If it fails for harness reasons, fix the TEST until it passes.
2. Now invert only the assertion so it describes the EXPECTED behaviour from the acceptance
   criteria. Run the command again. It must now FAIL, and the failure message must show the wrong
   value the ticket complains about.
3. Stop. Leave the file in its inverted (failing) state. Do not fix the code. Do not touch any other
   file. Do not commit.

The failing input must be one the TICKET gives — the value in its steps or screenshots, or the exact
configuration it describes. Do not go looking for some other input that happens to fail here; a red
on an invented value reproduces nothing the customer saw. If the ticket gives no concrete value and
the acceptance criteria do not imply one, say so with \`REPRO: none\`.

The assertion is about a VALUE the current code produces for the ticket's input — never about
whether a function, export or module exists. Calling a symbol that is not on this commit (through
\`?.\`, a cast, \`require\` in a try, or any other way) and asserting on \`undefined\` is not a
reproduction of anything; it is a test that the fix has not been written yet, and it will be rejected.

## It must also pass this repo's lint
The file is frozen the moment it goes red, so nothing can fix it afterwards — a lint error here
stops the whole run at the gate. Before you finish, run \`npx eslint <the file>\` and clear
anything it reports. In particular: import EXACTLY the way the nearest existing spec in this same
project imports, because a cross-package import the repo forbids fails
\`@nx/enforce-module-boundaries\`, and do not start a line with a semicolon.
${previous ? `\n## Previous attempt\n${previous}\n` : ''}
Finish with one line: \`REPRO: red\` if step 2 failed as intended; \`REPRO: wrong-location <file> <why>\`
if the symptom is produced somewhere the plan did not allow; or \`REPRO: none <one-sentence reason>\`
if the symptom cannot be made to fail in a test at this level (say why: needs a browser, needs a live
service, no concrete input in the ticket).`

/**
 * Why is this red? 'assertion' — an expect() ran and failed (or the code threw the very error the
 * ticket quotes); 'crash' — a TypeError/ReferenceError with no assertion in sight, i.e. the test's
 * own setup fell over inside production code; 'other' — anything else (left to the callers' checks).
 */
export function redFor(out, spec) {
  const text = String(out || '')
  const assertion = /expect\(|Expected[:\s]|Received[:\s]|AssertionError|toBe|toEqual|toHaveBeenCalled/.test(text)
  const quoted = spec?.symptom?.errorText && text.includes(String(spec.symptom.errorText).slice(0, 60))
  if (assertion || quoted) return 'assertion'
  if (/TypeError|ReferenceError|Cannot read propert/.test(text)) return 'crash'
  return 'other'
}

/** Red repro specs from earlier runs on this ticket, newest first: [{ run, file, src }]. */
export function priorRedSpecs(issueKey) {
  const runDir = process.env.PAG_RUN_DIR
  if (!runDir) return []
  const parent = path.dirname(path.resolve(runDir))
  let runs = []
  try { runs = fs.readdirSync(parent).filter((d) => d !== path.basename(runDir)).sort().reverse() } catch { return [] }
  const out = []
  for (const run of runs) {
    try {
      const dir = path.join(parent, run)
      const rec = fs.readdirSync(dir).find((f) => /^\d+-reproduce\.json$/.test(f))
      if (!rec) continue
      const repro = JSON.parse(fs.readFileSync(path.join(dir, rec), 'utf8'))?.output?.repro
      if (repro?.status !== 'red' || !repro.file) continue
      const src = fs.readFileSync(path.join(dir, 'evidence', 'repro.test.ts'), 'utf8')
      out.push({ run, file: repro.file, src })
    } catch { /* an incomplete run dir — skip */ }
  }
  return out
}

export function reproduceNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    // A red repro survives a re-plan: it pins the symptom, not the fix location.
    if (s.repro?.status === 'red' && fs.existsSync(path.join(s.repo, s.repro.file))) return {}

    const profile = loadProfile(s.repo)
    const isUi = (p) => profile.isUi(p)
    const target = (s.plan?.impactedFiles || []).find((f) => /\.[tj]sx?$/.test(f) && !/\.d\.ts$/.test(f))
    const specFile = target && reproPathFor(target)
    let rung = s.plan.impactedFiles.some(isUi) ? 'component' : 'unit'

    // No unit runner in this repo (or no source target): nothing to prove at this level.
    const command = specFile && reproCommand(s.repo, specFile)
    if (!command) {
      return { repro: { status: 'none', rung, reason: specFile
        ? `this repo has no unit test runner (profile ${profile.name}) — ${rung === 'component' ? 'a component test needs one' : 'a non-UI symptom cannot be proven here'}`
        : 'no source target to write a test against' } }
    }

    // ---- an earlier run on this ticket may already hold the right test ------------------------
    //
    // ESI2-3194: run 1 wrote a red test that pinned the exact mechanism (an automation-issued write
    // published with the upstream changeType) and was then refused for an unrelated reason; run 2
    // started from zero, ran out of money mid-trace, and froze a test that was red because of a
    // TypeError in its own mocks. Two runs, same base, opposite quality — pure variance. A red spec
    // that still fails on this tree is a fact about the code, not about the run that wrote it, so
    // reuse it: newest first, re-run here, and take the first that is red for an assertion reason.
    // …but only a spec that exercises what THIS plan targets. On ESI2-3194 r9 the plan targeted the
    // TypeError in the automation handler, the reused spec pinned the changeType path in
    // libs/collection, and patch had no way to make that test green inside the plan's files — it
    // escalated, and the re-plan swapped the second defect out for the first. A prior spec must
    // import, or sit beside, one of the impacted files; otherwise it is a different bug's test.
    const stems = (s.plan?.impactedFiles || []).map((f) => f.replace(/\.[tj]sx?$/, ''))
    const exercises = (prior) => {
      const dir = path.dirname(prior.file)
      if (stems.some((st) => path.dirname(st) === dir)) return true
      const specs = [...String(prior.src).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
      return specs.some((sp) => stems.some((st) => st.endsWith(sp.replace(/^(\.\.?\/)+/, '').replace(/\.[tj]sx?$/, '')) || path.basename(st) === path.basename(sp)))
    }
    for (const prior of priorRedSpecs(s.issueKey)) {
      if (prior.file !== specFile && !fs.existsSync(path.dirname(path.join(s.repo, prior.file)))) continue
      if (!exercises(prior)) { onProgress(`earlier repro from ${prior.run} (${path.basename(prior.file)}) tests none of the plan's files — not reusing it`); continue }
      const dest = prior.file
      fs.writeFileSync(path.join(s.repo, dest), prior.src)
      const red = await runSpec(s.repo, dest)
      const verdict = red.ok ? 'green on this tree' : /\?\.\(/.test(prior.src) ? 'a probe for a missing symbol' : redFor(red.out, s.spec) !== 'assertion' ? `red for the wrong reason (${redFor(red.out, s.spec)})` : null
      if (verdict) { fs.rmSync(path.join(s.repo, dest), { force: true }); onProgress(`earlier repro from ${prior.run} is ${verdict} — not reusing it`); continue }
      const sha = sha256(s.repo, dest)
      saveEvidence('repro.test.ts', prior.src); saveEvidence('repro-red.log', red.out)
      onProgress(`repro RED on ${String(s.baseSha).slice(0, 7)}: ${dest} — reused from run ${prior.run} ($0)`)
      return { repro: { status: 'red', file: dest, sha, rung, cmd: red.cmd, redExcerpt: excerpt(red.out), attempts: 0, reusedFrom: prior.run } }
    }

    const tier = tierFor('repro')
    let previous = ''
    const attempts = attemptsFor(budget)
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const allowance = Math.min(REPRO_BUDGET, budget.availableFor('repro'))
      const timeMs = attemptShare(budget, attempt, attempts)
      if (allowance < 0.3 || timeMs < 60_000) {
        return { repro: { status: 'none', reason: `skipped: $${allowance.toFixed(2)} / ${(timeMs / 1000).toFixed(0)}s left`, rung } }
      }

      onProgress(`repro attempt ${attempt}/${attempts} (${rung}) -> ${specFile}`)
      const r = await runClaude({
        cwd: s.repo, model: tier.model, budgetUsd: allowance, timeoutMs: timeMs, onProgress,
        prompt: PROMPT(s, { specFile, cmd: command.display, rung, previous }),
      })
      budget.charge('repro', r.cost, { model: tier.model, attempt, subtype: r.subtype, exit: r.code })

      // ---- the plan pointed at the wrong place, and this step is the first to read the code -----
      //
      // Run 6 on ESI2-3393: the model ran `git show 9288a5f -- get-template-columns.ts`, READ the
      // correct fix in local history, and then wrote a red test against group-separators.ts anyway,
      // because that was the file the plan allowed and there was no other answer it could give. It
      // invented `.50` to get a red. `patch` has had an escalation for months; this is the same one,
      // one step earlier, where the cost of being wrong is a whole run.
      const wrong = r.text.match(/REPRO:\s*wrong-location\s+(\S+)\s*(.*)/i)
      if (wrong) {
        const file = wrong[1].replace(/^[`'"]|[`'",.]+$/g, '').replace(new RegExp(`^${s.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '')
        fs.rmSync(path.join(s.repo, specFile), { force: true })
        if (fs.existsSync(path.join(s.repo, file)) && !(s.plan.impactedFiles || []).includes(file)) {
          onProgress(`repro says the plan is in the wrong place — the symptom is produced by ${file}: ${wrong[2].slice(0, 120)}`)
          return { escalation: { from: 'reproduce', text: r.text, neededFiles: [file] }, refusal: null }
        }
        onProgress(`repro named ${file} as the real location but it ${fs.existsSync(path.join(s.repo, file)) ? 'is already in the plan' : 'does not exist'} — continuing`)
        previous = `Attempt ${attempt}: you answered wrong-location ${file}, which ${fs.existsSync(path.join(s.repo, file)) ? 'is already an allowed file' : 'does not exist in this repo'}. Write the test, or name a file that exists and is not in the plan.`
        continue
      }

      // Mechanically undo anything that is not the one allowed file. The repro step never edits code.
      const { stdout: names } = await exec('git', ['diff', '--name-only', 'HEAD'], { cwd: s.repo, maxBuffer: 1 << 24 })
      const { stdout: untracked } = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: s.repo, maxBuffer: 1 << 24 })
      const stray = [...new Set([...names.split('\n'), ...untracked.split('\n')].map((x) => x.trim()).filter(Boolean))]
        .filter((p) => p !== specFile && !p.startsWith('.pag/'))
      if (stray.length) {
        onProgress(`repro touched ${stray.length} other file(s) — reverting: ${stray.slice(0, 4).join(', ')}`)
        const tracked = stray.filter((p) => names.includes(p))
        if (tracked.length) await exec('git', ['checkout', '--', ...tracked], { cwd: s.repo }).catch(() => {})
        for (const p of stray.filter((p) => !names.includes(p))) fs.rmSync(path.join(s.repo, p), { recursive: true, force: true })
      }

      if (!fs.existsSync(path.join(s.repo, specFile))) {
        // The model traced the path, found the plan's file is a thin dispatcher, and stopped —
        // naming the real file in prose but not in the `REPRO: wrong-location` line (3436 on CI:
        // "updateFormSubmit.ts only builds an SQS message", then $1.5 of nothing, then a patch
        // session with no anchor). Read the prose: a product file it names that is not in the plan
        // is the escalation it meant to send.
        const named = [...r.text.matchAll(/\bpackages\/[\w./-]+?\.tsx?\b/g)].map((m) => m[0])
          .filter((f) => !isTestFile(f) && !(s.plan.impactedFiles || []).includes(f) && fs.existsSync(path.join(s.repo, f)))
        const counts = named.reduce((m, f) => m.set(f, (m.get(f) || 0) + 1), new Map())
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        if (best && !/REPRO:\s*none/i.test(r.text)) {
          onProgress(`repro wrote no test and named ${best} as where the symptom is produced — re-planning there`)
          return { escalation: { from: 'reproduce', text: r.text, neededFiles: [best] }, refusal: null }
        }
        const said = (r.text.match(/REPRO:\s*none\s*(.*)/i) || [])[1] || 'no test file was written'
        previous = `Attempt ${attempt} wrote no file. It said: ${said}`
        if (/REPRO:\s*none/i.test(r.text) || r.timedOut) return { repro: { status: 'none', reason: said.trim(), rung, cost: r.cost } }
        continue
      }

      // A session the wall clock killed mid-edit leaves a file that is red for whatever state the
      // last Edit left it in — on ESI2-3348 (GitHub runner, slower jest) that half-test was accepted,
      // stayed red after a correct fix, and turned a good run into an incomplete hand-over that
      // superseded a complete PR. Only a test the model signed off (`REPRO: red`) is trusted; a
      // killed session gets another attempt with what it left, or `none` if it was the last.
      if (r.timedOut && !/REPRO:\s*red/i.test(r.text)) {
        onProgress(`repro ran out of time before finishing — the file it left is not trusted`)
        previous = `Attempt ${attempt} ran out of time before you finished. The file ${specFile} is your unfinished draft — read it, finish it fast (one test, one assertion), run it ONCE, then end with REPRO: red. Do not restart from scratch.`
        if (attempt === attempts) {
          fs.rmSync(path.join(s.repo, specFile), { force: true })
          return { repro: { status: 'none', reason: 'the reproducing test was not finished within the time budget', rung, cost: r.cost } }
        }
        continue
      }

      // The runner's word, not the model's: the spec must be RED on this (unpatched) tree.
      const red = await runSpec(s.repo, specFile)
      if (red.ok) {
        previous = `Attempt ${attempt}: the test PASSED on the unpatched code, so it does not reproduce the bug. ` +
          'Step 2 was not done or the assertion still describes current behaviour. Invert it to the EXPECTED behaviour.'
        onProgress('repro is green on the unpatched tree — not a reproduction')
        if (attempt === attempts) {
          fs.rmSync(path.join(s.repo, specFile), { force: true })
          return { repro: { status: 'none', reason: 'the test passed on the unpatched code — it does not reproduce the symptom', rung } }
        }
        continue
      }
      if (/\[TIMED OUT\]|Cannot find module|SyntaxError|Test suite failed to run/.test(red.out)) {
        previous = `Attempt ${attempt}: the test did not run:\n${excerpt(red.out)}`
        onProgress('repro did not execute (harness error)')
        if (attempt === attempts) {
          fs.rmSync(path.join(s.repo, specFile), { force: true })
          return { repro: { status: 'none', reason: 'the test could not be executed (harness error)', rung } }
        }
        continue
      }

      // ---- red for the RIGHT reason -----------------------------------------------------------
      //
      // Run 5 on ESI2-3393 went red with `expect(mod.validateNumericDecimalPlaces?.(...)).toBe(true)`
      // — a probe for a helper the PLAN intended to add, which does not exist on this commit, so
      // the assertion received `undefined`. It passed step 1, inverted cleanly, went red → green
      // through the whole run, and proved nothing about the bug: the patch that turned it green
      // fixed the wrong file. A test that goes red because a symbol is missing is a test that the
      // fix has not been written yet. Reject it here, while the spec is still this node's to edit.
      // `?.(` is an optional CALL — the only reason to write one in a test is that the callee may not
      // exist. Plain `?.` property access on a result is normal and is not flagged.
      const specSrc = fs.readFileSync(path.join(s.repo, specFile), 'utf8')
      if (redFor(red.out, s.spec) === 'crash') {
        // ESI2-3194 run 2: red with `TypeError: Cannot read properties of undefined (reading
        // 'viewOnlyFields')` at update-collection-record.ts:666 — a mock the test did not provide,
        // thrown before the code under test was reached. It went red → green through the whole
        // run and the "fix" was optional chaining around the crash. No assertion ever ran.
        previous = `Attempt ${attempt}: the test went red because the production code CRASHED on a missing mock `
          + `(${(red.out.match(/(TypeError|ReferenceError)[^\n]{0,140}/) || [])[0] || 'TypeError'}), before any assertion ran. `
          + 'That is a gap in the test setup, not the bug. Mock what that line needs (look at how the nearest '
          + 'existing spec in this project sets it up) so the code runs through to your expect(), and the red is an assertion failure.'
        onProgress('repro is red only because the harness crashed in production code (missing mock) — not a reproduction')
        if (attempt === attempts) {
          fs.rmSync(path.join(s.repo, specFile), { force: true })
          return { repro: { status: 'none', reason: 'the only red the test produced was a crash on a missing mock, before any assertion ran — that is not a reproduction of the symptom', rung } }
        }
        continue
      }
      if (/\?\.\(/.test(specSrc) || /is not a function|is not defined|has no exported member/.test(red.out)) {
        previous = `Attempt ${attempt}: the test went red because it calls something that does not exist on this commit `
          + '(an optional call, a cast, or a missing export), not because the code produced the wrong VALUE for the '
          + "ticket's input. Assert on what the current code actually returns or throws for the ticket's example, "
          + 'through the exports that exist today.'
        onProgress('repro is red only because it probes a symbol that does not exist yet — not a reproduction')
        if (attempt === attempts) {
          fs.rmSync(path.join(s.repo, specFile), { force: true })
          return { repro: { status: 'none', reason: 'the only red the test could produce was a probe for a not-yet-written helper — that is not a reproduction of the symptom', rung } }
        }
        continue
      }

      // ---- the spec must survive the repo's OWN lint, before it is frozen -------------------
      //
      // ESI2-3393 deadlocked here. The spec went red for exactly the right reason and found the
      // real root cause — and then `nx lint` failed on the spec itself (`no-extra-semi`,
      // `@nx/enforce-module-boundaries`). By then it was frozen, so `repair` could not touch it;
      // it burned all three attempts saying "the failures are in the file I am not allowed to
      // edit" and the run handed over with a red gate over two style errors in its own test.
      //
      // The freeze has to come AFTER the file is acceptable to the repo, not before. Right here
      // the spec is still this node's to edit, so lint it, hand the errors back, and try again.
      // Prettier first, same reason: pioneer's CI runs `nx format:check` as its own workflow, and a
      // spec frozen one space off fails it with nothing downstream allowed to touch the file.
      // Deterministic and content-preserving, so the red run above still describes this file.
      await exec('npx', ['--no-install', 'prettier', '--write', '--log-level', 'silent', specFile], { cwd: s.repo, timeout: 60_000 }).catch(() => {})
      const lint = await exec('npx', ['eslint', '--no-error-on-unmatched-pattern', specFile], { cwd: s.repo, maxBuffer: 1 << 24, timeout: 120_000 })
        .then(() => ({ ok: true, out: '' }))
        .catch((e) => ({ ok: false, out: `${e.stdout || ''}${e.stderr || ''}` }))
      if (!lint.ok) {
        const problems = parseGateFailures(lint.out, 'lint').filter((f) => specFile.endsWith(f.file) || f.file.endsWith(path.basename(specFile)))
        if (problems.length) {
          onProgress(`repro is red but fails the repo's lint (${problems.map((f) => f.rule).filter(Boolean).join(', ')}) — a frozen file cannot be fixed later, so fixing it now`)
          previous = `Attempt ${attempt}: the test correctly FAILED, which is right — but it does not pass this repo's lint, and once frozen nobody can fix it:\n\n${formatFailures(problems)}\n\n`
            + 'Keep the assertions exactly as they are. Fix only the lint problems. For module-boundary errors, import the same way the nearest existing spec in this project imports — do not reach across a package boundary the repo forbids.'
          if (attempt === attempts) {
            // Shipping a lint-dirty test into their repo is worse than shipping no test: it breaks
            // their CI on a file the reviewer did not write. Degrade honestly instead.
            fs.rmSync(path.join(s.repo, specFile), { force: true })
            return { repro: { status: 'none', rung, reason: `a reproducing test was written and it did fail correctly, but it could not be made to pass this repo's lint (${problems.map((f) => f.rule).filter(Boolean).join(', ')}) and a frozen test cannot be fixed afterwards` } }
          }
          continue
        }
      }

      // RED, and clean. Freeze it and keep the receipt.
      const sha = sha256(s.repo, specFile)
      saveEvidence('repro.test.ts', fs.readFileSync(path.join(s.repo, specFile), 'utf8'))
      saveEvidence('repro-red.log', red.out)
      const redExcerpt = excerpt(red.out)
      onProgress(`repro RED on ${String(s.baseSha).slice(0, 7)}: ${specFile}`)
      // Which explanation did the red settle? The model's closing line names it; the runner's red is
      // what makes the verdict count. Nothing in the plan changes except the verdicts.
      const verdicts = hypothesisVerdicts(s.plan?.hypotheses, r.text, specFile)
      if (verdicts.note) onProgress(verdicts.note)
      return {
        repro: { status: 'red', file: specFile, sha, rung, cmd: red.cmd, redExcerpt, attempts: attempt, hypothesis: verdicts.held },
        ...(verdicts.hypotheses ? { plan: { ...s.plan, hypotheses: verdicts.hypotheses } } : {}),
      }
    }
    return { repro: { status: 'none', reason: previous || 'exhausted attempts', rung } }
  }
}
