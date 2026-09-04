// The snapshot: a prepared base commit that runs pin to, plus a per-project baseline store.
//
// THE PROBLEM THIS SOLVES
// Runs used to branch from `origin/main` HEAD and compare against a baseline keyed by that exact
// sha. On a team that merges often that is unworkable: every merge invalidates the snapshot, and
// the next ticket is blocked behind a full-suite run. The mistake was the target — a baseline does
// not need to describe the LATEST main, it needs to describe the commit the run branches FROM.
//
// So: a background refresher prepares a commit (index + history + baselines) and marks it READY.
// Runs read the pin and branch from that, never from live HEAD. A ticket therefore never waits for
// anything, and it branches from a main that is at most one refresh interval old — which merges
// fine, and if it doesn't, that is a real conflict a human should see.
//
// AND WHY IT STAYS FAST
// Baselines are stored PER PROJECT, not per repo. When main moves, `nx show projects --affected`
// names the handful of projects a merge actually touched; only those are invalidated. A merge that
// touches 3 projects costs 3 project baselines, not 223. nx computes affected from the dependency
// graph, so a project whose dependency changed is correctly invalidated too — which a naive
// content hash of the project's own directory would miss.

import fs from 'node:fs'
import path from 'node:path'

const DIR = process.env.PAG_BASELINE_DIR || '.baseline'
const PROJ = () => path.join(DIR, 'projects')
const PIN = () => path.join(DIR, 'snapshot.json')

// ---- the pin ---------------------------------------------------------------------------------

/** @returns {{sha:string, base:string, indexedAt:string, refreshedAt:string, projects:number}|null} */
export function readPin() {
  try { return JSON.parse(fs.readFileSync(PIN(), 'utf8')) } catch { return null }
}

export function writePin(p) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(PIN(), JSON.stringify({ ...p, refreshedAt: new Date().toISOString() }, null, 2))
}

export function pinAgeHours() {
  const p = readPin()
  if (!p) return Infinity
  return (Date.now() - new Date(p.refreshedAt).getTime()) / 3.6e6
}

// ---- the baseline, computed CONCURRENTLY with the early nodes --------------------------------
//
// Baselining the clean checkout is what stops a pre-existing lint error being blamed on the patch
// (KAN-6). It is also a full lint + typecheck + test + build, which is 60-120s of the run's 20
// minutes — spent before intake had even read the ticket, with nothing else happening.
//
// Nothing needs it until `verify`, and verify is six minutes downstream. So ci.mjs starts it as a
// promise and registers it here; verify awaits `ready()` immediately before it consults the store.
// On the runs measured so far the wait is zero: the baseline finished during `patch`.
let pending = null

export function setPending(promise) {
  pending = Promise.resolve(promise).catch(() => null)
  return pending
}

/** Block until the concurrent baseline has been written (no-op when there is none). */
export async function ready() {
  if (!pending) return false
  await pending
  pending = null
  return true
}

// ---- per-project baselines -------------------------------------------------------------------

const projFile = (project) => path.join(PROJ(), `${project.replace(/[^\w.@-]/g, '_')}.json`)

/**
 * @param {string} project  nx project name
 * @returns {{project:string, sha:string, failed:boolean, tasks:string[], tests:string[], recordedAt:string}|null}
 */
export function readProject(project) {
  try { return JSON.parse(fs.readFileSync(projFile(project), 'utf8')) } catch { return null }
}

export function writeProject(project, { sha, failed, tasks = [], tests = [] }) {
  fs.mkdirSync(PROJ(), { recursive: true })
  fs.writeFileSync(projFile(project), JSON.stringify({
    project, sha, failed, tasks: [...tasks].sort(), tests: [...tests].sort(),
    recordedAt: new Date().toISOString(),
  }, null, 2))
}

export function forget(project) {
  try { fs.rmSync(projFile(project)) ; return true } catch { return false }
}

export function knownProjects() {
  try { return fs.readdirSync(PROJ()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) } catch { return [] }
}

/** Which of `projects` have no cached baseline — i.e. must be computed before the gate can judge them. */
export function missing(projects) {
  return projects.filter((p) => !readProject(p))
}

/**
 * The baseline for a set of projects, merged into the two sets `verdict()` wants.
 * A project with no cached baseline contributes nothing, so the caller must check `missing()` first
 * — otherwise its pre-existing failures would read as regressions.
 */
export function baselineFor(projects) {
  const tasks = new Set(), tests = new Set()
  for (const p of projects) {
    const b = readProject(p)
    if (!b) continue
    for (const t of b.tasks) tasks.add(t)
    for (const t of b.tests) tests.add(t)
  }
  return { tasks, tests }
}
