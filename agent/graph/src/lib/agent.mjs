// The one way this workflow runs Claude Code. patch, repair and reproduce all shell out to
// `claude -p`; keeping the invocation here means the git denylist, the budget flag, the stream
// parser and the wall-clock kill are decided once and cannot drift between nodes.
//
// Two limits, both enforced by the tool layer rather than the prompt:
//   --max-budget-usd   Claude Code stops itself at the dollar cap (exit subtype error_max_budget_usd)
//   timeoutMs          we kill the process when the run's remaining wall-clock is gone; the node
//                      then reports `exit_timeout` and the graph routes to refuse. A run that is
//                      going to miss the 20-minute target should fail fast, not finish late.

import { spawn } from 'node:child_process'
import { TIERS, estimateCost } from './models.mjs'

export const GIT_DENYLIST = [
  'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)',
  'Bash(git branch:*)', 'Bash(git reset:*)', 'Bash(git stash:*)', 'Bash(gh pr:*)',
]

/** Parse Claude Code's stream-json for the final result + cost. */
export function parseStream(lines) {
  let cost = 0, subtype = '', text = ''
  // Token usage accumulated from every assistant turn, so a session killed before its `result`
  // event (wall clock) still bills. ESI2-3348's reproduce ran 3 minutes of Opus and was charged $0.
  const usage = { inTok: 0, outTok: 0 }
  for (const raw of lines) {
    let e
    try { e = JSON.parse(raw) } catch { continue }
    if (e.type === 'assistant' && e.message?.usage) {
      const u = e.message.usage
      usage.inTok += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1 + (u.cache_creation_input_tokens || 0) * 1.25
      usage.outTok += u.output_tokens || 0
    }
    if (e.type === 'result') {
      cost = e.total_cost_usd ?? e.cost_usd ?? 0
      subtype = e.subtype || ''
      text = e.result || ''
    }
  }
  return { cost, subtype, text, usage }
}

/**
 * @returns {Promise<{code:number, cost:number, subtype:string, text:string, timedOut:boolean}>}
 */
export function runClaude({ cwd, prompt, model, budgetUsd, timeoutMs, onProgress = () => {}, disallowed = GIT_DENYLIST, mcpConfig = null }) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--max-budget-usd', String(Number(budgetUsd).toFixed(2)),
    '--output-format', 'stream-json', '--verbose',
    // See nodes/patch.mjs for why: there is nobody to answer a permission prompt, the worktree is
    // disposable, git is denied below, and the real diff is checked against the plan afterwards.
    '--dangerously-skip-permissions',
    '--disallowedTools', ...disallowed,
  ]
  // Per-call beats the env var: only the witness gets a browser, and only for the run that asked.
  const mcp = mcpConfig || process.env.PAG_MCP_CONFIG
  if (mcp) args.push('--strict-mcp-config', '--mcp-config', mcp)

  const lines = []
  let timedOut = false
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, CLAUDE_CODE_USE_BEDROCK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const parts = buf.split('\n'); buf = parts.pop()
      for (const p of parts) if (p.trim()) { lines.push(p); onProgress(p) }
    })
    child.stderr.on('data', (d) => onProgress(String(d)))

    let timer = null
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        onProgress(`wall-clock budget exhausted — stopping claude after ${(timeoutMs / 1000).toFixed(0)}s`)
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
      }, timeoutMs)
    }

    const done = (code) => {
      if (timer) clearTimeout(timer)
      const r = parseStream(lines)
      if (!r.cost && (r.usage.inTok || r.usage.outTok)) {
        // No `result` event (killed): price the turns we saw at the model's list rates.
        const tier = Object.values(TIERS).find((t) => t.model === model) || Object.values(TIERS).find((t) => /opus/i.test(t.model)) || { priceIn: 5, priceOut: 25 }
        r.cost = estimateCost(tier, r.usage.inTok, r.usage.outTok)
        onProgress(`claude ended without a result event — billing ${Math.round(r.usage.inTok)} in / ${r.usage.outTok} out tokens as $${r.cost.toFixed(3)}`)
      }
      resolve({ code, ...r, subtype: timedOut ? 'exit_timeout' : r.subtype, timedOut })
    }
    child.on('close', done)
    child.on('error', () => done(-1))
  })
}
