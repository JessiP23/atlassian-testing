// Eyes for the witness.
//
// THE PROBLEM, measured over three runs of ESI2-3406. The model authored a Playwright spec for an
// app it could not see. Its only way to look was to write a spec that console.logs the DOM and run
// it — 30-45s per glance, out of a 210s budget. Run 1 guessed selectors and captured nothing. Run 2
// died on `waitForURL(/\/home/)`. Run 3 spent every second on probe specs and never wrote an
// assertion. That is not a prompting problem; it is a missing sense.
//
// THE FIX. `@playwright/mcp` exposes the browser as tools: browser_navigate, browser_snapshot,
// browser_click, browser_type. `browser_snapshot` returns the live accessibility tree — real roles,
// real labels — in context, instantly, with no spec written and no run paid for. The model looks,
// clicks, confirms, and only then writes a spec from selectors it has verified. Nothing downstream
// changes: the spec it emits is plain Playwright, run by our own config, producing the same
// screenshots, video and trace.
//
// The authoring browser loads a storageState baked by bin/login-state.mjs, so the model starts
// signed in and the password never reaches its transcript.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const GRAPH_DIR = path.resolve(import.meta.dirname, '../..')
const TEMPLATE = path.join(GRAPH_DIR, 'witness', 'mcp.template.json')

export const mcpEnabled = () => process.env.PAG_WITNESS_MCP !== '0'

/**
 * Sign in once and write the browser state. Returns the path, or null if it could not.
 * Cached for the process: one login per run, not one per attempt.
 */
let statePromise = null
export function loginState({ appUrl, onProgress = () => {} }) {
  if (statePromise) return statePromise
  const out = path.join(GRAPH_DIR, '.pag', 'login-state.json')
  statePromise = exec('node', [path.join(GRAPH_DIR, 'bin', 'login-state.mjs'), '--url', appUrl, '--out', out],
    { cwd: GRAPH_DIR, timeout: 120_000 })
    .then(() => { onProgress('authoring browser: signed in, state cached'); return out })
    .catch((e) => { onProgress(`authoring browser: could not sign in (${String(e.message).split('\n')[0].slice(0, 90)}) — it will explore signed out`); return null })
  return statePromise
}

/**
 * Write the per-run MCP config. Returns its path, or null when the template is missing.
 * A config without a state file is still useful — the model can still SEE, it just starts at /login.
 */
export function writeConfig({ statePath }) {
  try {
    // ABSOLUTE, and OUTSIDE evidence/.
    //
    // Two bugs in one line, the first time round. The path was relative, and runClaude runs with
    // cwd = the product worktree, so Claude Code looked for it under pioneer-agent/ and refused to
    // start: "MCP config file not found". And it lived under evidence/witness/, where the MCP
    // server dropped a unix socket — which pushEvidence then tried to copyFileSync, got ENOTSUP,
    // and abandoned the whole upload. That is why a PR that used to carry the ticket screenshots
    // suddenly carried none. evidence/ holds evidence; scratch goes here.
    const outDir = path.join(GRAPH_DIR, '.pag', 'authoring')
    const tpl = fs.readFileSync(TEMPLATE, 'utf8')
    const cfg = JSON.parse(tpl.replace('__STATE__', statePath || '').replace('__OUT__', outDir))
    if (!statePath) {
      const args = cfg.mcpServers.playwright.args
      const i = args.indexOf('--storage-state')
      if (i >= 0) args.splice(i, 2)
    }
    fs.mkdirSync(outDir, { recursive: true })
    const p = path.join(outDir, 'mcp.json')
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
    return p
  } catch { return null }
}
