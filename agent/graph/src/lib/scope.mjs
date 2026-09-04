// Which projects does the gate run on? The answer is the profile's, not the graph's.
//
// THE PROBLEM THIS SOLVES: `nx affected` on a shared schema change named 196 projects with 133
// failures that were already red on main, and the run reported them as its own. So the gate runs on
// the projects that OWN the changed files, type-surface changes fan out one level for build only,
// and baseline subtraction (lib/baseline.mjs) turns the verdict into "N NEW failures".
//
// On a single-package repo the same shape holds with one project called "app" — nothing downstream
// (per-project baselines, the snapshot store, the PR footer) needs to know the difference.

import { loadProfile } from '../../profiles/index.mjs'

/** @returns {{owners:string[], typeConsumers:string[], plan:Array<{target,projects,argv}>}} */
export async function scopeFor(repo, changed) {
  const profile = loadProfile(repo)
  const owners = [...new Set(changed.map((f) => profile.ownerOf(repo, f)).filter(Boolean))]
  const typeConsumers = owners.length ? await profile.typeConsumersFor(repo, changed, owners) : []
  const plan = profile.gate(repo, { owners, typeConsumers })
  return { owners, typeConsumers, plan, profile: profile.name }
}

/**
 * The plan already carries its argv — this keeps the call site in verify.mjs unchanged.
 * `exclusive` (must run alone: it writes a build dir the dev server is using) and `optional`
 * (the deadline may drop it) travel with it, because verify schedules on them.
 */
export function commandsFor(plan) {
  return plan.map(({ target, projects, argv, exclusive = false, optional = false }) =>
    ({ target, projects, argv, exclusive, optional }))
}

/** Still used by the context pack and by repro path resolution. */
export function ownerOf(repo, file) {
  return loadProfile(repo).ownerOf(repo, file)
}
