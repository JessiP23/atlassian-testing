// Path guard. Decides which files a run is ALLOWED to have changed, and is enforced on the
// real git diff after the patch node — never as an instruction in a prompt.
//
// Two independent jobs:
//
//   A. DENY: files that must never appear in an agent commit regardless of the ticket.
//      This is the leak class. On run ESI2-3376 the commit set was derived as
//      `git diff --name-only HEAD` minus a regex that covered `runtime/` and `panda-code-agent/`
//      but NOT `.env` — and `.env` was git-TRACKED with five live credentials in it. It would
//      have been committed and pushed. Cody's `changed-files.sh` was right in shape and wrong
//      in coverage, so the shape is kept here and the coverage is widened.
//
//   B. ALLOW: files the PLAN said it would touch. Anything outside that is scope creep, which is
//      how "fix one ternary" becomes a 52-file diff. The plan names impactedFiles up front; the
//      guard holds the patch to it. Widening requires a recorded reason, not a bigger diff.

// Never committed by an agent. Ordered roughly by how bad the mistake would be.
export const DENY = [
  /(^|\/)\.env($|\.)/,                 // .env, .env.local, .env.sample — the credential class
  /(^|\/)\.npmrc$/,
  /(^|\/)\.tempcreds/,
  /(^|\/)id_rsa|\.pem$|\.p12$|\.keystore$/,
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.nx\//,
  /^runtime\//,                        // agent scratch
  /^panda-code-agent\//,               // another agent's source
  /^agent\//,                          // THIS agent's own source, when vendored into the repo
  /^\.claude\//,
  /^\.github\//,                       // an agent must not edit its own CI or agent definitions
  /package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/, // lockfile churn hides real changes
]

// Generated artifacts: a real change here is legitimate but must come from running the generator,
// so they are allowed only when the plan explicitly listed them.
export const GENERATED = [
  /^packages\/shared\/graphql\/src\/schema\/schema\.types\.ts$/,   // nx profile
  /integrationImages\.ts$/,
  /\/locales\/[a-zA-Z-]+\//,
  /^\.next\//, /^out\//,                                          // nextjs profile
]

/**
 * The agent's own OUTPUT, as opposed to its source. Test-runner artefacts, the run folder, the
 * index: these appear in `git status` when they are not ignored, and DENY (`^agent/`) then refuses
 * a run whose code changes were perfectly correct — which is exactly what happened on KAN-6, at the
 * last step, after the fix was written and the witness had gone green. Scratch is not a diff, so
 * it is filtered out of the changed set before the guard ever sees it. Editing agent SOURCE stays
 * denied.
 */
export const SCRATCH = [
  /(^|\/)pw-(out|manual|before|after)\//,      // Playwright output dirs
  /(^|\/)test-results\//,
  /(^|\/)playwright-report\//,
  /^agent\/(runs|\.par|\.baseline)\//,
  /^\.pag\//,
]

export const isScratch = (p) => SCRATCH.some((re) => re.test(p))

export function isDenied(path) {
  return DENY.some((re) => re.test(path))
}

export function isGenerated(path) {
  return GENERATED.some((re) => re.test(path))
}

/**
 * Is `p` a test file for one of `sources`, in a conventional location?
 *
 * Needed because the planner names production files in `impactedFiles` and test files in
 * `newTests` — so a guard checking only `impactedFiles` rejects the very tests it demanded. That is
 * exactly what happened on the first real run: three test files the plan required were reported as
 * scope creep and the run refused after $5.66 of correct work.
 *
 * Recognised: `X.test.ts`, `X.spec.ts`, `__tests__/X.test.ts` beside the source, any extension.
 */
export function isTestFor(p, sources) {
  const m = p.match(/^(.*?)(?:\/__tests__)?\/([^/]+)\.(test|spec)\.[tj]sx?$/)
  if (!m) return false
  const [, dir, stem] = m
  return sources.some((src) => {
    const sm = src.match(/^(.*)\/([^/]+)\.[tj]sx?$/)
    if (!sm) return false
    const [, sdir, sstem] = sm
    return sdir === dir && sstem === stem
  })
}

/** Any test file at all — used to report test drift separately from production drift. */
export const isTestFile = (p) => /(?:^|\/)(?:__tests__\/)?[^/]+\.(?:test|spec)\.[tj]sx?$/.test(p)

/**
 * Classify a real changed-file list against the plan.
 *
 * @param {string[]} changed  paths from `git diff --name-only` (+ untracked)
 * @param {string[]} allow    plan.impactedFiles
 * @returns {{ ok:boolean, denied:string[], outOfScope:string[], generated:string[], inScope:string[] }}
 */
export function classify(changed, allow, plannedTests = []) {
  const allowSet = new Set([...allow, ...plannedTests])
  const denied = [], outOfScope = [], generated = [], inScope = []

  for (const p of changed) {
    if (isDenied(p)) { denied.push(p); continue }
    if (allowSet.has(p)) { inScope.push(p); continue }
    // A test beside an allowed source is in scope even if the plan spelled its path differently
    // (`__tests__/x.test.ts` vs `x.test.ts` is a coin flip the planner should not have to win).
    if (isTestFor(p, allow)) { inScope.push(p); continue }
    if (isGenerated(p)) { generated.push(p); continue }
    outOfScope.push(p)
  }
  // `denied` is fatal and non-negotiable. `outOfScope` is a judgement call the graph routes on.
  return { ok: denied.length === 0, denied, outOfScope, generated, inScope }
}

/** Hard budget on diff size. A bug fix that rewrites 800 lines is not a bug fix. */
export const DIFF_LIMITS = {
  maxFiles: Number(process.env.PAG_MAX_FILES || 12),
  maxLines: Number(process.env.PAG_MAX_LINES || 400),
}

export function overBudget({ files, insertions, deletions }) {
  const lines = insertions + deletions
  const reasons = []
  if (files > DIFF_LIMITS.maxFiles) reasons.push(`${files} files > ${DIFF_LIMITS.maxFiles}`)
  if (lines > DIFF_LIMITS.maxLines) reasons.push(`${lines} changed lines > ${DIFF_LIMITS.maxLines}`)
  return reasons
}
