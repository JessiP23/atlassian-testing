// The gate. Deterministic — no model runs here, and no model decides whether the patch is good.
//
// This node is the direct answer to "it does not test the updates". On ESI2-3376 the agent DID run
// its own tests and they passed; what failed is that the repo-wide gate afterwards could not
// distinguish its patch from 133 assertions that were already red on `main`. Three mechanisms fix
// it, and all three live outside the model:
//
//   lib/secrets.mjs   scans the ADDED LINES for credentials. The path guard cannot see inside a
//                     file, so a key written into an allowed source file used to pass everything.
//   lib/scope.mjs     runs the gate on the projects that OWN the changed files (7), not the
//                     affected closure (196). Type-surface changes fan out to `build` only.
//   lib/baseline.mjs  subtracts the failures already present on the base commit, so the verdict is
//                     "N NEW failures", never "N failures".
//
// ORDER IS THE DESIGN. Cheapest and most fatal first: the secret scan is milliseconds and its
// verdict is final; the frozen repro is seconds and speaks to the actual bug; the gate is minutes
// and speaks only to regressions. A run that leaked a credential must never pay for a build.
//
// CONCURRENCY. lint, typecheck and test are independent read-only processes and were run in
// series, which on a Next.js app is ~40s of dead clock per verify pass — and verify runs twice
// whenever repair fires. They now run together. `build` is `exclusive` in the profile because it
// writes the same .next/ the witness's dev server is reading, so it runs alone, with the app
// stopped, and it is `optional`: under a tight deadline the run reports "build skipped" in the PR
// instead of blowing the 20-minute budget. tsc --noEmit already covers most of what it would catch.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scopeFor, commandsFor } from '../lib/scope.mjs'
import { verdict, summarise } from '../lib/baseline.mjs'
import * as snap from '../lib/snapshot.mjs'
import { runSpec, sha256, saveEvidence, excerpt, runWitness, collectWitness } from '../lib/repro.mjs'
import { ensureApp, stopApp, warmApp } from '../lib/app.mjs'
import { scanDiff, formatFindings } from '../lib/secrets.mjs'
import { parseGateFailures, summariseFailures } from '../lib/gatelog.mjs'
import fs from 'node:fs'
import path from 'node:path'

const exec = promisify(execFile)

async function run(repo, argv, timeoutMs) {
  const bin = argv[0] === 'npm' || argv[0] === 'npx' ? argv[0] : 'npx'
  const rest = argv[0] === 'npm' || argv[0] === 'npx' ? argv.slice(1) : argv
  try {
    const { stdout, stderr } = await exec(bin, rest, { cwd: repo, maxBuffer: 1 << 26, timeout: timeoutMs })
    return { ok: true, out: stdout + stderr }
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.killed ? '\n[TIMED OUT]' : ''}` }
  }
}

export function verifyNode({ budget, onProgress = () => {} } = {}) {
  return async (s) => {
    // nx generators rewrite files as a side effect of test/build (integrationImages.ts, the locale
    // bundles). Snapshot the changed set BEFORE the gate runs so that drift introduced BY the gate
    // is never mistaken for part of the patch — the publish node commits `s.changed`, and if the
    // gate silently added files to the working tree they would ride along into the PR.
    const beforeGate = new Set(s.changed)

    // ---- (0) NOTHING gets past a credential in the diff ----------------------------------------
    // Milliseconds, and the only check here whose answer is never "try again": a model that wrote
    // a key does not get a repair attempt with that key still in its context. Added lines only —
    // a secret that was already in the file fails every run forever and is somebody else's ticket.
    try {
      const { stdout: full } = await exec('git', ['diff', 'HEAD'], { cwd: s.repo, maxBuffer: 1 << 26 })
      const untrackedBodies = await Promise.all((s.changed || [])
        .filter((f) => !full.includes(`b/${f}`))
        .map(async (f) => {
          try { return `\n--- NEW FILE: ${f}\n${fs.readFileSync(path.join(s.repo, f), 'utf8')}` } catch { return '' }
        }))
      const scan = scanDiff(full + untrackedBodies.join(''))
      if (!scan.ok) {
        onProgress(`SECRET-SHAPED CONTENT in ${scan.findings.length} added line(s) — refusing`)
        return {
          secrets: scan.findings,
          refusal: {
            at: 'verify', reason: 'secret_in_diff',
            detail: `The patch adds ${scan.findings.length} line(s) that look like a credential. Nothing was `
              + `committed or pushed.\n\n${formatFindings(scan.findings)}\n\n`
              + `If one of these is genuinely not a secret, the reviewable way to say so is a \`pag-allow-secret\` `
              + `comment on that line, which is greppable in the repo.`,
          },
        }
      }
    } catch (e) { onProgress(`secret scan skipped: ${e.message}`) }

    // ---- (a) the frozen reproducing test is unchanged, (b) it is now GREEN ----------------------
    // Before the gate: seconds, and the only part of this node that speaks to the reported bug
    // rather than to regressions. A patch that edited the repro is rejected outright — that is the
    // "green for the wrong reason" class. A patch that leaves it red goes to repair like any other
    // gate failure.
    let evidence = null
    if (s.repro?.status === 'red') {
      const now = sha256(s.repo, s.repro.file)
      if (now !== s.repro.sha) {
        return {
          refusal: {
            at: 'verify', reason: 'repro_tampered',
            detail: now
              ? `${s.repro.file} was modified by the patch step. The reproducing test is frozen; a fix must make it pass as written.`
              : `${s.repro.file} was deleted by the patch step.`,
          },
        }
      }
      onProgress(`repro: re-running ${s.repro.file}`)
      let green, after = null
      if (s.repro.rung === 'e2e') {
        // Same dev server, same spec; HMR has already applied the patch. If the server died,
        // bring it back — a witness that cannot run is a gate failure, not a pass.
        const app = await ensureApp({ repo: s.repo, onProgress })
        if (!app) return { gate: { ok: false, target: 'repro', summary: 'the app could not be started for the witness re-run', newFailures: [], preExisting: [], failures: [], logTail: '' } }
        await new Promise((r) => setTimeout(r, 3_000)) // let HMR settle
        green = await runWitness(s.repro.file, 'after')
        if (green.ok) after = await collectWitness(green.outDir, 'after')
      } else {
        green = await runSpec(s.repo, s.repro.file)
      }
      if (!green.ok) {
        onProgress('repro still RED after patch')
        const failures = parseGateFailures(green.out, 'repro')
        return {
          gate: {
            ok: false, target: 'repro',
            summary: `the reproducing test is still failing after the patch: ${path.basename(s.repro.file)}`,
            newFailures: [], preExisting: [], failures, logTail: green.out.slice(-8000),
          },
        }
      }
      saveEvidence('repro-green.log', green.out)
      evidence = {
        reproGreen: true, greenExcerpt: excerpt(green.out),
        after: after && { shots: after.shots.map((f) => path.basename(f)), video: after.video && path.basename(after.video), gif: after.gif && path.basename(after.gif), trace: after.trace && path.basename(after.trace) },
      }
      onProgress(`repro GREEN on the patched tree${after ? ` — ${after.shots.length} screenshot(s), gif ${after.gif ? 'yes' : 'no'}` : ''}`)
    }

    const scope = await scopeFor(s.repo, s.changed)
    if (!scope.plan.length) {
      return { scope, evidence, gate: { ok: false, target: 'scope', summary: 'no owning project for the changed files — cannot verify' } }
    }

    onProgress(`gate scope: ${scope.owners.length} owner project(s), ${scope.typeConsumers.length} type consumer(s)`)

    // The baseline was started concurrently by ci.mjs and is needed for the first time HERE, six
    // minutes downstream of where it used to block. On every run measured so far this wait is 0ms.
    const waited = Date.now()
    if (await snap.ready()) onProgress(`baseline: waited ${((Date.now() - waited) / 1000).toFixed(1)}s for the concurrent clean-checkout run`)

    // Per-project baselines. Only the projects this run touches are consulted, so a red project
    // elsewhere in the monorepo is irrelevant — and a merge that changed three projects only ever
    // invalidated three records.
    const consulted = [...new Set([...scope.owners, ...scope.typeConsumers])]
    const unknown = snap.missing(consulted)
    const { tasks: baseTasks, tests: base } = snap.baselineFor(consulted)
    onProgress(`baseline: ${consulted.length - unknown.length}/${consulted.length} project(s) known, ${baseTasks.size} pre-existing failing task(s)`)

    // A project with no baseline is only a problem if it FAILS in this run. If it passes there is
    // nothing to attribute, so an unknown-but-green project must not block the gate — otherwise a
    // first run has to wait out a full-suite baseline before it can judge anything. Unknown AND
    // red is the case that genuinely cannot be attributed, and that is handled at the verdict.
    const unknownSet = new Set(unknown)

    const cmds = commandsFor(scope.plan)
    const parallel = cmds.filter((c) => !c.exclusive)
    const serial = cmds.filter((c) => c.exclusive)
    const skipped = []

    // Timeouts come off the clock, not out of a constant. `verify` may hold budget.timeFor('verify')
    // and no more; a gate command that would run past the run's deadline is killed, and the
    // resulting `[TIMED OUT]` is reported as a gate failure rather than silently overrunning.
    const slice = () => Math.max(30_000, budget ? budget.timeFor('verify') : 240_000)

    const results = []
    if (parallel.length) {
      onProgress(`gate: ${parallel.map((c) => c.target).join(' + ')} concurrently`)
      const t0 = Date.now()
      const out = await Promise.all(parallel.map(async (c) => ({ ...c, ...(await run(s.repo, c.argv, slice())) })))
      onProgress(`gate: ${parallel.length} target(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      results.push(...out)
    }
    for (const c of serial) {
      // Exclusive targets need the app's port and output dir to themselves.
      if (c.optional && budget && budget.timeFor('verify') < 90_000) {
        skipped.push(c.target)
        onProgress(`gate ${c.target}: SKIPPED — ${(budget.timeLeftMs() / 1000).toFixed(0)}s left on the run's clock, and it is optional (tsc covers most of it). Recorded in the PR.`)
        continue
      }
      onProgress(`gate ${c.target}: ${c.projects.length} project(s), exclusive`)
      stopApp()
      results.push({ ...c, ...(await run(s.repo, c.argv, slice())) })
    }
    // If this verify pass ends up going to repair, the NEXT pass has to re-run the witness — and
    // `stopApp()` above just killed the server, so it would pay a 20-40s cold boot inside its own
    // slice. Start it warming in the background now instead; if the gate was green nothing else
    // asks for it and `stopApp()` in ci.mjs's finally block cleans it up.
    if (serial.length && s.repro?.rung === 'e2e' && !budget?.pastDeadline()) {
      warmApp({ repo: s.repo, onProgress })
    }

    for (const { target, projects, ok, out } of results) {
      if (ok) continue
      const failures = parseGateFailures(out, target)

      // lint / typecheck / build used to be treated as unambiguous — "nothing pre-existing gets
      // past nx affected on a clean main". That is false wherever the gate command covers more than
      // the patch: `npm run lint` lints the WHOLE repo, and on KAN-6 the only error was in the
      // agent's own vendored source, so a correct patch was blamed for it and the run burned its
      // remaining budget in repair trying to fix something it had not broken.
      //
      // So these targets are baseline-subtracted too, at TARGET granularity (`app:lint`): if the
      // same target already failed on the pinned commit, it is pre-existing and the gate continues.
      if (target !== 'test') {
        const preExistingTargets = projects.map((p) => `${p}:${target}`).filter((id) => baseTasks.has(id))
        if (preExistingTargets.length === projects.length) {
          onProgress(`gate ${target}: failed, but ${preExistingTargets.join(', ')} already failed on ${String(s.baseSha).slice(0, 7)} — pre-existing, not this patch`)
          continue
        }
        // Second, sharper subtraction: even in a project with no target-level baseline, a failure
        // in a file this patch never touched is not this patch's failure. `npm run lint` covering
        // the whole repo is the normal case, not the exception.
        const mineFailures = failures.filter((f) => !f.file || (s.changed || []).some((c) => c === f.file || c.endsWith('/' + f.file) || f.file.endsWith('/' + c)))
        if (failures.length && !mineFailures.length) {
          onProgress(`gate ${target}: ${failures.length} failure(s), none in a file this patch changed — not attributable to it`)
          continue
        }
        const mine = projects.filter((p) => !baseTasks.has(`${p}:${target}`))
        return {
          scope, evidence,
          gate: {
            ok: false, target,
            summary: `${target} failed in ${mine.join(', ')}${failures.length ? ` — ${summariseFailures(mineFailures.length ? mineFailures : failures)}` : ''}`
              + (preExistingTargets.length ? ` (${preExistingTargets.join(', ')} was already failing on ${String(s.baseSha).slice(0, 7)} and is ignored)` : ''),
            newFailures: [], preExisting: preExistingTargets, skipped,
            failures: mineFailures.length ? mineFailures : failures,
            logTail: out.slice(-8000),
          },
        }
      }

      const v = verdict(out, base, baseTasks)

      // Split the new failures: ones in projects we have a baseline for (real regressions) from
      // ones in projects we do not (unattributable — could be pre-existing).
      const unattributable = (v.newTasks || []).filter((t) => unknownSet.has(t.split(':')[0]))
      const regressions = (v.newTasks || []).filter((t) => !unknownSet.has(t.split(':')[0]))

      if (!regressions.length && !v.newFailures.length && unattributable.length) {
        return {
          scope, evidence,
          gate: {
            ok: false, target,
            summary: `${unattributable.length} failing task(s) in project(s) with no baseline: ${unattributable.join(', ')} — cannot tell if this patch caused them`,
            newFailures: [], newTasks: unattributable, preExisting: v.preExisting, failures, skipped,
            logTail: `These projects have never been baselined, so their failures cannot be attributed.\nPrepare them:\n  node bin/refresh.mjs --repo ~/pioneer-refresh --base ${s.baseBranch} --force\n\n${out.slice(-6000)}`,
          },
        }
      }

      const summary = summarise({ ...v, newTasks: regressions }, s.baseSha)
      onProgress(`gate test: ${summary}`)

      if (v.attributable && !regressions.length && v.newFailures.length === 0) continue

      return {
        scope, evidence,
        gate: { ok: false, target, summary, newFailures: v.newFailures, newTasks: regressions, preExisting: v.preExisting, failures, skipped, logTail: out.slice(-8000) },
      }
    }

    // Revert anything the gate itself wrote, so the commit set is exactly the patch.
    try {
      const { stdout } = await exec('git', ['diff', '--name-only', 'HEAD'], { cwd: s.repo, maxBuffer: 1 << 24 })
      const drift = stdout.split('\n').map((x) => x.trim()).filter((x) => x && !beforeGate.has(x))
      if (drift.length) {
        onProgress(`reverting ${drift.length} file(s) the gate's generators rewrote: ${drift.slice(0, 4).join(', ')}`)
        await exec('git', ['checkout', '--', ...drift], { cwd: s.repo })
      }
    } catch { /* non-fatal: the guard in publish still enforces the plan's allowlist */ }

    const ran = results.map((r) => r.target)
    return {
      scope, evidence,
      gate: {
        ok: true, target: 'all', skipped,
        summary: `green across ${scope.owners.length} owning project(s) — ${ran.join(', ')}`
          + (skipped.length ? ` · ${skipped.join(', ')} skipped for the clock` : ''),
      },
    }
  }
}
