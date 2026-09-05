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
import { reproPathFor, reproCommand, runSpec, sha256, saveEvidence, excerpt,
  witnessSpecPath, witnessCommand, runWitness, collectWitness, shipWitness, WITNESS_FIXTURES } from '../lib/repro.mjs'
import { ensureApp } from '../lib/app.mjs'
import { parseGateFailures, formatFailures } from '../lib/gatelog.mjs'
import { loadProfile } from '../../profiles/index.mjs'

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
const attemptShare = (budget, attempt) => budget.phaseTimeFor('reproduce', ATTEMPTS - attempt + 1)

const UI_EVIDENCE = process.env.PAG_UI_EVIDENCE === '1'

// The witness rung: a Playwright spec against the RUNNING app. Same protocol (pass-first, invert,
// red), different runner, and the artefacts are screenshots + video instead of a jest log.
// A half-filled .env is worse than an empty one: `PAG_APP_EMAIL=<QA user>` is truthy, so the
// witness would spend a model call writing a login flow that cannot possibly work. Treat an
// unreplaced placeholder as absent.
const real = (v) => {
  const x = String(v ?? '').trim()
  return x && !/[<>]/.test(x) && !/^(your|todo|changeme|xxx)/i.test(x) ? x : ''
}
const HAS_LOGIN = () => Boolean(real(process.env.PAG_APP_EMAIL) && real(process.env.PAG_APP_PASSWORD))

const WITNESS_PROMPT = (s, { specFile, cmd, appUrl, previous, hasLogin }) => `You are writing a WITNESS for ${s.issueKey}: a Playwright spec that drives the running app
at ${appUrl} and FAILS because of the bug the ticket reports. You are NOT fixing anything. A separate
step fixes the code; the app hot-reloads; your spec must then pass unchanged.

## The bug, from the ticket
${s.spec.summary}

## Acceptance criteria (the EXPECTED behaviour)
${(s.spec.acceptanceCriteria || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}

## Where the fix will go (read these files in the worktree ${s.repo} to learn routes, labels, test ids)
${s.plan.impactedFiles.map((f) => `- ${f}`).join('\n')}

## The ONE file you may create — exactly this absolute path, nothing else
    ${specFile}

Start from:
    import { test, expect, check, ${hasLogin ? 'login, ' : ''}shot } from '${WITNESS_FIXTURES}'
${hasLogin
  ? `- \`login(page)\` signs in as the QA user (env-provided; never hard-code credentials).`
  : `- THERE IS NO USABLE LOGIN in this environment. Do NOT import or call \`login\`, do not type any
  credentials, and do not try to reach a screen behind authentication. You may only visit pages that
  render WITHOUT signing in: \`/login\`, \`/signup\`, \`/forgot-password\`. If the ticket's symptom is
  only visible after signing in, stop and answer \`REPRO: none needs an authenticated session\`.`}
- \`check(page, '02-after-toggle-dark', async () => { ... })\` is HOW YOU ASSERT. It runs soft
  assertions and screenshots the state it judged. Use it for EVERY acceptance criterion, in the
  order a user meets them, naming the STATE:
      01-initial-load · 02-after-toggle-dark · 03-reloaded-still-dark · 04-toggled-back-light
  Soft matters: a hard \`expect\` throws on the first unmet criterion, so the run's only evidence is
  one frame of a flow nobody saw. With \`check\` the spec walks the WHOLE flow, captures every
  state, and still FAILS at the end if any assertion failed. Inside a check use \`expect.soft(...)\`.
- \`shot(page, 'NN-name')\` alone for a state worth picturing but not asserting.
- The same spec re-runs after the fix and the PR pairs the two runs BY SCREENSHOT NAME, so keep the
  names stable and descriptive — \`02-after-toggle-dark\` before vs after is the whole story.
- Cover BOTH SIDES of a toggle or a mode: if the ticket is about light and dark, assert and shoot
  light AND dark, not only the new one.
- Locate elements by role/label/text (\`getByRole\`, \`getByLabel\`, \`getByText\`), never by CSS class.
  Wait with \`expect(...).toBeVisible()\` / \`toHaveText\`, never \`waitForTimeout\`.
- For a layout/padding/colour symptom assert computed style, which is exact and stable:
  \`await expect(el).toHaveCSS('background-color', 'rgb(43, 5, 72)')\` — Playwright reports colours as
  \`rgb(r, g, b)\`, so convert any hex in the ticket before asserting.
- Use only data you create in the test or that clearly already exists; never delete or change account
  settings. Keep it to ONE test.
- Do not edit any file under ${s.repo}. Do not commit.

## Run it with exactly this command
    ${cmd}

## Protocol — pass first, then invert
1. Write the test so its final assertion describes the CURRENT (wrong) behaviour and it PASSES against
   the running app. Run the command; fix selectors/flow until it passes. This proves login, navigation
   and locators work.
2. Invert only the final assertion to the EXPECTED behaviour from the acceptance criteria. Run again.
   It must now FAIL with a message that shows the wrong state.
3. Stop, leaving the file in its inverted (failing) state. Check the run produced ONE SCREENSHOT
   PER \`check\` — if it stopped after the first frame you used a hard \`expect\` where \`check\`
   belongs.
${previous ? `\n## Previous attempt\n${previous}\n` : ''}
Finish with one line: \`REPRO: red\` or \`REPRO: none <one-sentence reason>\` (e.g. the flow needs data the QA
account does not have, or the symptom is backend-only and not visible in the client).`

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

export function reproduceNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    // A red repro survives a re-plan: it pins the symptom, not the fix location.
    if (s.repro?.status === 'red' && fs.existsSync(path.join(s.repo, s.repro.file))) return {}

    const profile = loadProfile(s.repo)
    const isUi = (p) => profile.isUi(p)
    const target = (s.plan?.impactedFiles || []).find((f) => /\.[tj]sx?$/.test(f) && !/\.d\.ts$/.test(f))
    const specFile = target && reproPathFor(target)
    let rung = s.plan.impactedFiles.some(isUi) ? 'component' : 'unit'

    // Witness rung: only for web-app targets, only when enabled, only if the app comes up.
    // A backend-only diff never climbs here — against the shared backend the client would show the
    // OLD behaviour and the "evidence" would be a lie.
    if (rung === 'component' && UI_EVIDENCE) {
      const app = await ensureApp({ repo: s.repo, onProgress })
      if (app) {
        const w = await witness(s, { budget, onProgress, appUrl: app.url })
        if (w) return w
        onProgress('witness did not reproduce — falling back to a component test')
      } else onProgress('web-app could not be started — falling back to a component test')
    }

    // No unit runner in this repo (or no source target): the witness above was the only rung.
    const command = specFile && reproCommand(s.repo, specFile)
    if (!command) {
      return { repro: { status: 'none', rung, reason: specFile
        ? `this repo has no unit test runner (profile ${profile.name}) — ${rung === 'component' ? 'the browser witness could not reproduce it either' : 'a non-UI symptom cannot be proven here'}`
        : 'no source target to write a test against' } }
    }

    const tier = tierFor('repro')
    let previous = ''
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const allowance = Math.min(REPRO_BUDGET, budget.availableFor('repro'))
      const timeMs = attemptShare(budget, attempt)
      if (allowance < 0.3 || timeMs < 60_000) {
        return { repro: { status: 'none', reason: `skipped: $${allowance.toFixed(2)} / ${(timeMs / 1000).toFixed(0)}s left`, rung } }
      }

      onProgress(`repro attempt ${attempt}/${ATTEMPTS} (${rung}) -> ${specFile}`)
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
        const said = (r.text.match(/REPRO:\s*none\s*(.*)/i) || [])[1] || 'no test file was written'
        previous = `Attempt ${attempt} wrote no file. It said: ${said}`
        if (/REPRO:\s*none/i.test(r.text) || r.timedOut) return { repro: { status: 'none', reason: said.trim(), rung, cost: r.cost } }
        continue
      }

      // The runner's word, not the model's: the spec must be RED on this (unpatched) tree.
      const red = await runSpec(s.repo, specFile)
      if (red.ok) {
        previous = `Attempt ${attempt}: the test PASSED on the unpatched code, so it does not reproduce the bug. ` +
          'Step 2 was not done or the assertion still describes current behaviour. Invert it to the EXPECTED behaviour.'
        onProgress('repro is green on the unpatched tree — not a reproduction')
        if (attempt === ATTEMPTS) {
          fs.rmSync(path.join(s.repo, specFile), { force: true })
          return { repro: { status: 'none', reason: 'the test passed on the unpatched code — it does not reproduce the symptom', rung } }
        }
        continue
      }
      if (/\[TIMED OUT\]|Cannot find module|SyntaxError|Test suite failed to run/.test(red.out)) {
        previous = `Attempt ${attempt}: the test did not run:\n${excerpt(red.out)}`
        onProgress('repro did not execute (harness error)')
        if (attempt === ATTEMPTS) {
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
      if (/\?\.\(/.test(specSrc) || /is not a function|is not defined|has no exported member/.test(red.out)) {
        previous = `Attempt ${attempt}: the test went red because it calls something that does not exist on this commit `
          + '(an optional call, a cast, or a missing export), not because the code produced the wrong VALUE for the '
          + "ticket's input. Assert on what the current code actually returns or throws for the ticket's example, "
          + 'through the exports that exist today.'
        onProgress('repro is red only because it probes a symbol that does not exist yet — not a reproduction')
        if (attempt === ATTEMPTS) {
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
          if (attempt === ATTEMPTS) {
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
      return {
        repro: { status: 'red', file: specFile, sha, rung, cmd: red.cmd, redExcerpt, attempts: attempt },
      }
    }
    return { repro: { status: 'none', reason: previous || 'exhausted attempts', rung } }
  }
}

/** The witness rung. Returns a red repro (with before-shots) or null to fall back. */
async function witness(s, { budget, onProgress, appUrl }) {
  const specFile = witnessSpecPath(s.issueKey)
  if (!specFile) return null
  const tier = tierFor('repro')
  const cmd = witnessCommand(specFile)
  let previous = ''
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const allowance = Math.min(REPRO_BUDGET, budget.availableFor('repro'))
    const timeMs = attemptShare(budget, attempt)
    if (allowance < 0.3 || timeMs < 90_000) return null

    onProgress(`witness attempt ${attempt}/${ATTEMPTS} -> ${specFile}`)
    const r = await runClaude({
      cwd: s.repo, model: tier.model, budgetUsd: allowance, timeoutMs: timeMs, onProgress,
      prompt: WITNESS_PROMPT(s, { specFile, cmd, appUrl, previous, hasLogin: HAS_LOGIN() }),
    })
    budget.charge('repro', r.cost, { model: tier.model, attempt, subtype: r.subtype, exit: r.code, rung: 'e2e' })

    // The witness never touches the product tree. Revert anything it did.
    const { stdout: names } = await exec('git', ['diff', '--name-only', 'HEAD'], { cwd: s.repo, maxBuffer: 1 << 24 })
    const { stdout: untracked } = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: s.repo, maxBuffer: 1 << 24 })
    const stray = [...new Set([...names.split('\n'), ...untracked.split('\n')].map((x) => x.trim()).filter(Boolean))].filter((p) => !p.startsWith('.pag/'))
    if (stray.length) {
      onProgress(`witness touched ${stray.length} file(s) in the worktree — reverting`)
      const tracked = stray.filter((p) => names.includes(p))
      if (tracked.length) await exec('git', ['checkout', '--', ...tracked], { cwd: s.repo }).catch(() => {})
      for (const p of stray.filter((p) => !names.includes(p))) fs.rmSync(path.join(s.repo, p), { recursive: true, force: true })
    }

    if (!fs.existsSync(specFile)) {
      if (/REPRO:\s*none/i.test(r.text) || r.timedOut) return null
      previous = `Attempt ${attempt} wrote no spec file.`
      continue
    }

    const red = await runWitness(specFile, 'before')
    if (red.ok) {
      previous = `Attempt ${attempt}: the spec PASSED against the unpatched app, so it does not witness the bug. Invert the final assertion to the EXPECTED behaviour.`
      onProgress('witness is green on the unpatched app — not a reproduction')
      if (attempt === ATTEMPTS) { fs.rmSync(specFile, { force: true }); return null }
      continue
    }
    if (/browserType\.launch|Executable doesn't exist|Cannot find (module|package)|SyntaxError|No tests found|\[TIMED OUT\]/.test(red.out)) {
      previous = `Attempt ${attempt}: the spec did not run:\n${excerpt(red.out)}`
      onProgress('witness did not execute (harness error)')
      if (attempt === ATTEMPTS) { fs.rmSync(specFile, { force: true }); return null }
      continue
    }

    const before = await collectWitness(red.outDir, 'before')
    saveEvidence('repro-red.log', red.out)
    onProgress(`witness RED against ${appUrl}: ${before.shots.length} screenshot(s), video ${before.video ? 'yes' : 'no'}`)

    // Put the spec in the repo when the repo can run it, so the reviewer gets the reproducing test
    // as reviewable, re-runnable code and not only as a picture. Before patch, so the gate covers
    // it. A repo without @playwright/test returns [] and nothing is added to the diff.
    const shipped = shipWitness(s.repo, specFile, s.issueKey)
    if (shipped.length) onProgress(`witness committed to the diff: ${shipped.join(', ')}`)

    return {
      repro: {
        status: 'red', rung: 'e2e', file: specFile, sha: sha256(s.repo, specFile), cmd, shipped,
        redExcerpt: excerpt(red.out), attempts: attempt, appUrl,
        before: { shots: before.shots.map((f) => path.basename(f)), video: before.video && path.basename(before.video), gif: before.gif && path.basename(before.gif), trace: before.trace && path.basename(before.trace) },
      },
    }
  }
  return null
}
