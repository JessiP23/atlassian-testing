// Repo profiles: everything the workflow needs to know about a SPECIFIC codebase, in one file
// per codebase. The graph itself contains no repo knowledge — that was the thing that made the
// first version impossible to move between projects.
//
// A profile answers six questions:
//   1. which files are UI (decides whether a ticket can get screenshots)
//   2. which "projects" own the changed files (the unit the gate runs on)
//   3. what the gate commands are, per target — and which of them may run concurrently
//   4. how to run ONE test file (the reproducing-test rung; null when the repo has no test runner)
//   5. how to start the app, and where it answers (the witness rung)
//   6. whether a generated Playwright spec can be COMMITTED here so it ships in the diff (e2eDir)
//
// Selection: PAG_PROFILE, else auto-detect from the repo root. Adding a codebase = adding a file
// here, not editing the graph.

import fs from 'node:fs'
import path from 'node:path'
import nextjs from './nextjs.mjs'
import nx from './nx.mjs'

const PROFILES = { nextjs, nx }

export function detectProfile(repo) {
  if (fs.existsSync(path.join(repo, 'nx.json'))) return 'nx'
  if (fs.readdirSync(repo).some((f) => /^next\.config\./.test(f))) return 'nextjs'
  return 'nextjs'
}

// Defaults for capabilities a profile does not declare, so adding a question to the list above
// never breaks an existing profile.
const DEFAULTS = {
  e2eDir: () => null,
}

export function loadProfile(repo) {
  const name = process.env.PAG_PROFILE || detectProfile(repo)
  const p = PROFILES[name]
  if (!p) throw new Error(`unknown PAG_PROFILE "${name}" — available: ${Object.keys(PROFILES).join(', ')}`)
  return { ...DEFAULTS, ...p }
}
