// The gate. Deterministic — no model runs here, and no model decides whether the patch is good.
//
// This node is the direct answer to "it does not test the updates". On ESI2-3376 the agent DID run
// its own tests and they passed; what failed is that the repo-wide gate afterwards could not
// distinguish its patch from 133 assertions that were already red on `main`. Two mechanisms fix it,
// and both live outside the model:
//
//   lib/scope.mjs     runs the gate on the projects that OWN the changed files (7), not the
//                     affected closure (196). Type-surface changes fan out to `build` only.
//   lib/baseline.mjs  subtracts the failures already present on the base commit, so the verdict is
//                     "N NEW failures", never "N failures".

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scopeFor, commandsFor } from '../lib/scope.mjs'
import { verdict, summarise } from '../lib/baseline.mjs'
import * as snap from '../lib/snapshot.mjs'
import { runSpec, sha256, saveEvidence, excerpt, runWitness, collectWitness } from '../lib/repro.mjs'
import { ensureApp } from '../lib/app.mjs'
import path from 'node:path'

const exec = promisify(execFile)

async function run(repo, argv, timeoutMs) {
  try {
    const { stdout, stderr } = await exec('npx', argv, { cwd: repo, maxBuffer: 1 << 26, timeout: timeoutMs })
    return { ok: true, out: stdout + stderr }
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.killed ? '\n[TIMED OUT]' : ''}` }
  }
}

export function verifyNode({ onProgress = () => {} } = {}) {
  return async (s) => {
    // nx generators rewrite files as a side effect of test/build (integrationImages.ts, the locale
    // bundles). Snapshot the changed set BEFORE the gate runs so that drift introduced BY the gate
    // is never mistaken for part of the patch — the publish node commits `s.changed`, and if the
    // gate silently added files to the working tree they would ride along into the PR.
    const beforeGate = new Set(s.changed)

    // ---- (a) the frozen reproducing test is unchanged, (b) it is now GREEN ----------------------
    // Both before the gate: they take seconds and they are the only part of this node that speaks
    // to the reported bug rather than to regressions. A patch that edited the repro is rejected
    // outright — that is the "green for the wrong reason" class. A patch that leaves it red goes to
    // repair with the failure, like any other gate failure.
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
        // Same dev server, same spec; Vite HMR has already applied the patch. If the server died,
        // bring it back — a witness that cannot run is a gate failure, not a pass.
        const app = await ensureApp({ repo: s.repo, onProgress })
        if (!app) return { gate: { ok: false, target: 'repro', summary: 'web-app could not be started for the witness re-run', newFailures: [], preExisting: [], logTail: '' } }
        await new Promise((r) => setTimeout(r, 3_000)) // let HMR settle
        green = await runWitness(s.repro.file, 'after')
        if (green.ok) after = await collectWitness(green.outDir, 'after')
      } else {
        green = await runSpec(s.repo, s.repro.file)
      }
      if (!green.ok) {
        onProgress('repro still RED after patch')
        return {
          gate: {
            ok: false, target: 'repro',
            summary: `the reproducing test is still failing after the patch: ${s.repro.file}`,
            newFailures: [], preExisting: [], logTail: green.out.slice(-8000),
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
      return { scope, evidence, gate: { ok: false, target: 'scope', summary: 'no owning nx project for the changed files — cannot verify' } }
    }

    onProgress(`gate scope: ${scope.owners.length} owner project(s), ${scope.typeConsumers.length} type consumer(s) (was 196 unscoped)`)

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

    for (const { target, projects, argv } of cmds) {
      onProgress(`gate ${target}: ${projects.length} project(s)`)
      const timeout = target === 'build' ? 25 * 60_000 : 15 * 60_000
      const { ok, out } = await run(s.repo, argv, timeout)
      if (ok) continue

      // lint/build failures are unambiguous: nothing pre-existing gets past `nx affected` on a
      // clean main, and a compile error in an owned project is always the patch's.
      if (target !== 'test') {
        return {
          scope, evidence,
          gate: { ok: false, target, summary: `${target} failed in ${projects.join(', ')}`, newFailures: [], preExisting: [], logTail: out.slice(-8000) },
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
            newFailures: [], newTasks: unattributable, preExisting: v.preExisting,
            logTail: `These projects have never been baselined, so their failures cannot be attributed.\nPrepare them:\n  node bin/refresh.mjs --repo ~/pioneer-refresh --base ${s.baseBranch} --force\n\n${out.slice(-6000)}`,
          },
        }
      }

      const summary = summarise({ ...v, newTasks: regressions }, s.baseSha)
      onProgress(`gate test: ${summary}`)

      if (v.attributable && !regressions.length && v.newFailures.length === 0) continue

      return {
        scope, evidence,
        gate: { ok: false, target, summary, newFailures: v.newFailures, newTasks: regressions, preExisting: v.preExisting, logTail: out.slice(-8000) },
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

    return { scope, evidence, gate: { ok: true, target: 'all', summary: `green across ${scope.owners.length} owning project(s)` } }
  }
}
