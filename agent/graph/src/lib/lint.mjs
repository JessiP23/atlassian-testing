// One way to run eslint on a few files, the way THIS repo needs it.
//
// eslint 9 looks for eslint.config.* and errors out on a repo that still uses .eslintrc.*: "ESLint couldn't
// find an eslint.config.(js|mjs|cjs) file". On pioneer that turned the reproduce node's pre-freeze lint into
// a no-op (a config error parses as zero per-file problems → "clean" → frozen with `no-extra-semi`, gate red,
// INCOMPLETE hand-over on ESI2-3441), and cost every model session a round of `ls eslint.config.* .eslintrc*`
// archaeology before it found ESLINT_USE_FLAT_CONFIG=false. Decide it once here; tell the prompts the answer.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseGateFailures } from './gatelog.mjs'

const exec = promisify(execFile)

/** 'legacy' (.eslintrc.* and no eslint.config.*), 'flat', or 'none'. */
export function eslintMode(repo) {
  const has = (re) => { try { return fs.readdirSync(repo).some((f) => re.test(f)) } catch { return false } }
  if (has(/^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/)) return 'flat'
  if (has(/^\.eslintrc(\.(js|cjs|json|yaml|yml))?$/)) return 'legacy'
  return 'none'
}

/** The exact command a model session should run — printed into prompts so nobody rediscovers it. */
export function eslintCommand(repo, files = ['<files>']) {
  const mode = eslintMode(repo)
  if (mode === 'none') return null
  return `${mode === 'legacy' ? 'ESLINT_USE_FLAT_CONFIG=false ' : ''}npx eslint ${files.join(' ')}`
}

/**
 * Lint files. Returns { ok, problems, configError }. A config error is NOT clean: the caller must treat
 * it as "could not lint" and say so, never as "no problems".
 */
export async function lintFiles(repo, files, { timeoutMs = 120_000 } = {}) {
  const mode = eslintMode(repo)
  if (mode === 'none' || !files.length) return { ok: true, problems: [], configError: null, skipped: mode === 'none' }
  const env = { ...process.env, ...(mode === 'legacy' ? { ESLINT_USE_FLAT_CONFIG: 'false' } : {}) }
  try {
    await exec('npx', ['eslint', '--no-error-on-unmatched-pattern', ...files], { cwd: repo, env, maxBuffer: 1 << 24, timeout: timeoutMs })
    return { ok: true, problems: [], configError: null }
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    if (/couldn't find an eslint\.config|couldn't find a configuration file|ESLINT_USE_FLAT_CONFIG|Invalid option|Oops! Something went wrong/i.test(out)) {
      return { ok: false, problems: [], configError: out.split('\n').find((l) => l.trim())?.slice(0, 200) || 'eslint configuration error' }
    }
    const problems = parseGateFailures(out, 'lint').filter((f) => files.some((spec) => spec.endsWith(f.file) || f.file.endsWith(path.basename(spec))))
    return { ok: problems.length === 0 && !e.code, problems, configError: null, out }
  }
}
