// Deterministic side of the reproducing test: run one spec file, hash it, keep the evidence.
// No model here. The reproduce node WRITES the spec; this module is how the workflow proves what
// it does — red on the pinned commit, green on the patched tree — and keeps the receipts.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadProfile } from '../../profiles/index.mjs'

const GRAPH_DIR = path.resolve(import.meta.dirname, '../..')
export const WITNESS_CONFIG = path.join(GRAPH_DIR, 'witness/playwright.config.mjs')
export const WITNESS_FIXTURES = path.join(GRAPH_DIR, 'witness/fixtures.mjs')

const exec = promisify(execFile)

export const REPRO_TIMEOUT_MS = Number(process.env.PAG_REPRO_TIMEOUT_MS || 5 * 60_000)

/** `<dir>/<stem>.repro.test.<ext>` beside the first target — one predictable place, always. */
export function reproPathFor(target) {
  const m = target.match(/^(.*)\/([^/]+)\.([tj]sx?)$/)
  if (!m) return null
  const [, dir, stem, ext] = m
  return `${dir}/${stem}.repro.test.${ext}`
}

/**
 * The exact command a reviewer can paste, from the profile. `null` means this repo has no unit
 * test runner — the unit rung is unavailable and reproduce falls through to the witness.
 */
export function reproCommand(repo, specFile) {
  return loadProfile(repo).testOne(repo, specFile)
}

/** @returns {Promise<{ok:boolean, out:string, cmd:string}>} */
export async function runSpec(repo, specFile, { timeoutMs = REPRO_TIMEOUT_MS } = {}) {
  const cmd = reproCommand(repo, specFile)
  if (!cmd) return { ok: false, out: `no nx project owns ${specFile}`, cmd: '' }
  try {
    const { stdout, stderr } = await exec('npx', cmd.argv, { cwd: repo, maxBuffer: 1 << 26, timeout: timeoutMs })
    return { ok: true, out: stdout + stderr, cmd: cmd.display }
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.killed ? '\n[TIMED OUT]' : ''}`, cmd: cmd.display }
  }
}

export function sha256(repo, file) {
  const abs = path.isAbsolute(file) ? file : path.join(repo, file)
  try { return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') } catch { return null }
}

/** runs/<KEY>/<runId>/evidence/<name> — the receipts publish renders. Never fails a run. */
export function saveEvidence(name, content) {
  const runDir = process.env.PAG_RUN_DIR
  if (!runDir) return null
  try {
    const dir = path.join(runDir, 'evidence')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    return p
  } catch { return null }
}

/**
 * The lines a reviewer needs from a jest run, not the stack trace. nx prefixes every line with
 * `project: `, so strip that first; then take the `●` failure block (assertion + expected/received)
 * for a red run, or the PASS block with its ✓ lines for a green one, through the `Tests:` summary.
 */
export function excerpt(out, { maxLines = 24 } = {}) {
  const lines = out
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[\w@/.-]+:\s/, ''))
    .filter((l) => !/DeprecationWarning|--trace-deprecation|^\(node:\d+\)/.test(l))
  // jest: ● / PASS / FAIL headers. Playwright list reporter: "✘  1 [chromium] › spec:12:5 › name".
  const isHeader = (l) => (/^\s*(●|PASS|FAIL)\s/.test(l) && !/●\s+Console/.test(l)) || /^\s*[✘✓✔×]\s+\d+\s/.test(l)
  let start = lines.findIndex(isHeader)
  if (start === -1) start = Math.max(0, lines.length - maxLines)
  // Stop before the stack trace ("at ...") and resume at the Tests: summary so both fit.
  const body = []
  for (let i = start; i < lines.length && body.length < maxLines; i++) {
    const l = lines[i]
    if (/^\s+at\s/.test(l)) continue
    if (/^\s*(Test Suites|Tests|Snapshots|Time):/.test(l) || body.length < maxLines - 4) body.push(l)
  }
  return body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---- the witness rung: a Playwright spec run against the live app -----------------------------

/** Where the generated e2e spec lives: beside the evidence, never in the product repo. */
export function witnessSpecPath(issueKey) {
  const runDir = process.env.PAG_RUN_DIR
  if (!runDir) return null
  const dir = path.join(runDir, 'evidence', 'witness')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${issueKey}.spec.mjs`)
}

export function witnessCommand(specFile) {
  // cd first: `npx playwright` from the product worktree would try to DOWNLOAD playwright.
  return `cd ${GRAPH_DIR} && PAG_WITNESS_DIR=${path.dirname(specFile)} npx playwright test --config ${WITNESS_CONFIG} ${path.basename(specFile)}`
}

/**
 * Run the witness spec once. `label` is 'before' or 'after'; artefacts land in
 * evidence/pw-<label>/ so the two passes never overwrite each other.
 * @returns {Promise<{ok:boolean, out:string, cmd:string, outDir:string}>}
 */
export async function runWitness(specFile, label, { timeoutMs = REPRO_TIMEOUT_MS } = {}) {
  const outDir = path.join(path.dirname(path.dirname(specFile)), `pw-${label}`)
  fs.rmSync(outDir, { recursive: true, force: true })
  const env = { ...process.env, PAG_WITNESS_DIR: path.dirname(specFile), PAG_WITNESS_OUT: outDir, CI: '1' }
  const argv = ['playwright', 'test', '--config', WITNESS_CONFIG, path.basename(specFile)]
  try {
    const { stdout, stderr } = await exec('npx', argv, { cwd: GRAPH_DIR, env, maxBuffer: 1 << 26, timeout: timeoutMs })
    return { ok: true, out: stdout + stderr, cmd: witnessCommand(specFile), outDir }
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.killed ? '\n[TIMED OUT]' : ''}`, cmd: witnessCommand(specFile), outDir }
  }
}

/**
 * Flatten Playwright's per-test output into evidence/<label>-NN-<name>.png, <label>.webm,
 * <label>-trace.zip, and (when ffmpeg is present) <label>.gif ≤ 10 MB so GitHub renders it inline.
 * @returns {{shots:string[], video:string|null, trace:string|null, gif:string|null}}
 */
export async function collectWitness(outDir, label) {
  const runDir = process.env.PAG_RUN_DIR
  const res = { shots: [], video: null, trace: null, gif: null }
  if (!runDir || !fs.existsSync(outDir)) return res
  const dest = path.join(runDir, 'evidence')
  fs.mkdirSync(dest, { recursive: true })
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  const files = walk(outDir).sort()
  let n = 0
  for (const f of files) {
    const base = path.basename(f)
    if (/\.png$/.test(base) && !/-diff\.png$|-actual\.png$|-expected\.png$/.test(base)) {
      // Named shots (from fixtures.shot) keep their name; Playwright's automatic ones get numbered.
      const name = /^\d\d-/.test(base) ? base : `${String(++n + 90).padStart(2, '0')}-${base}`
      const to = path.join(dest, `${label}-${name}`)
      fs.copyFileSync(f, to); res.shots.push(to)
    } else if (/\.webm$/.test(base) && !res.video) {
      res.video = path.join(dest, `${label}.webm`); fs.copyFileSync(f, res.video)
    } else if (/^trace.*\.zip$/.test(base) && !res.trace) {
      res.trace = path.join(dest, `${label}-trace.zip`); fs.copyFileSync(f, res.trace)
    }
  }
  if (res.video) res.gif = await makeGif(res.video, path.join(dest, `${label}.gif`))
  return res
}

/** webm -> gif via ffmpeg when available; 720px wide, 8 fps, palette-optimised. null if no ffmpeg. */
export async function makeGif(webm, gif) {
  try { await exec('ffmpeg', ['-version'], { timeout: 5_000 }) } catch { return null }
  try {
    await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm,
      '-vf', 'fps=8,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
      gif], { timeout: 120_000 })
    const mb = fs.statSync(gif).size / 1048576
    if (mb > 10) { fs.rmSync(gif, { force: true }); return null }
    return gif
  } catch { return null }
}
