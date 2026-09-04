// Step-by-step visibility. Two independent surfaces, because they answer different questions.
//
//   LangSmith  — "where did the tokens and seconds go, and did that prompt change help?"
//                Enabled by env vars alone, no code. Best for comparing runs and models.
//   Disk trace — "what exactly happened on THIS run?"
//                A directory per run: one JSON per node plus a human-readable timeline.
//                Works with no network, no account, and survives the container.
//
// The disk trace exists because a production incident at 2am is not the moment to discover your
// only record of what the agent did lives behind a SaaS login. It is also what you read to answer
// "why did it refuse", which is the most common question this system will generate.
//
// Nothing sensitive is written: node outputs are state deltas (paths, verdicts, costs), and file
// bodies never enter graph state by design.

import fs from 'node:fs'
import path from 'node:path'

export function isLangSmithOn() {
  return process.env.LANGSMITH_TRACING === 'true' && Boolean(process.env.LANGSMITH_API_KEY)
}

export class Trace {
  constructor({ issueKey, runId, dir = process.env.PAG_RUNS_DIR || 'runs' }) {
    this.runId = runId
    this.issueKey = issueKey
    this.dir = path.join(dir, issueKey, runId)
    this.step = 0
    this.t0 = Date.now()
    this.events = []
    fs.mkdirSync(this.dir, { recursive: true })
  }

  /** Called before a node runs. */
  begin(node, input) {
    this.step++
    this._current = { step: this.step, node, startedAt: new Date().toISOString(), t: Date.now() }
    // Inputs are large and mostly repeated from the previous step's output, so only the keys are
    // recorded — the state at each boundary is reconstructable from the outputs.
    this._current.inputKeys = Object.keys(input || {}).filter((k) => input[k] !== undefined)
    return this._current.step
  }

  /** Called after a node returns. `update` is the partial state it produced. */
  end(node, update, extra = {}) {
    const c = this._current || { step: ++this.step, node, t: Date.now() }
    const rec = {
      step: c.step,
      node,
      startedAt: c.startedAt,
      durationMs: Date.now() - c.t,
      elapsedMs: Date.now() - this.t0,
      inputKeys: c.inputKeys,
      output: update,
      ...extra,
    }
    const file = path.join(this.dir, `${String(c.step).padStart(2, '0')}-${node}.json`)
    fs.writeFileSync(file, JSON.stringify(rec, null, 2))
    this.events.push(rec)
    this._current = null
    return rec
  }

  /** Free-text lines interleaved into the timeline — subprocess output, gate progress. */
  note(node, line) {
    const s = String(line).trim()
    if (!s) return
    fs.appendFileSync(path.join(this.dir, 'stream.log'), `[${((Date.now() - this.t0) / 1000).toFixed(1)}s] ${node}: ${s}\n`)
  }

  /** A single markdown file a human reads to understand the run. Rewritten after every node. */
  timeline(ledger) {
    const rows = this.events.map((e) => {
      const spent = ledger?.byNode?.[e.node]
      const bits = []
      if (e.output?.located) bits.push(e.output.located.map((p) => p.path).join(', '))
      if (e.output?.plan?.impactedFiles) bits.push(`plan: ${e.output.plan.impactedFiles.join(', ')}`)
      if (e.output?.repro) bits.push(e.output.repro.status === 'red' ? `repro RED: ${e.output.repro.file}` : `repro none: ${e.output.repro.reason || ''}`)
      if (e.output?.evidence?.reproGreen) bits.push('repro GREEN')
      if (e.output?.diffStat) bits.push(`${e.output.diffStat.files} files +${e.output.diffStat.insertions}/-${e.output.diffStat.deletions}`)
      if (e.output?.gate) bits.push(e.output.gate.summary)
      if (e.output?.refusal) bits.push(`REFUSED: ${e.output.refusal.reason} — ${e.output.refusal.detail || ''}`)
      if (e.output?.prUrl) bits.push(e.output.prUrl)
      return `| ${e.step} | \`${e.node}\` | ${(e.durationMs / 1000).toFixed(1)}s | ${spent ? '$' + spent.toFixed(4) : '—'} | ${bits.join(' · ') || '—'} |`
    })

    const md = [
      `# ${this.issueKey} — run ${this.runId}`,
      '',
      `Started ${new Date(this.t0).toISOString()} · ${((Date.now() - this.t0) / 1000).toFixed(0)}s elapsed`,
      ledger ? `Spent **$${ledger.spent.toFixed(4)}** of $${ledger.capUsd} (reserve $${ledger.reserveUsd})` : '',
      isLangSmithOn() ? `LangSmith project: \`${process.env.LANGSMITH_PROJECT || 'default'}\`` : 'LangSmith: off',
      '',
      '| # | node | wall | cost | outcome |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      'Per-node state deltas are in the numbered JSON files beside this one; raw subprocess output',
      'is in `stream.log`.',
    ].filter((l) => l !== '').join('\n')

    fs.writeFileSync(path.join(this.dir, 'timeline.md'), md)
    return md
  }
}

/**
 * Wrap every node so tracing is applied in ONE place. A node that has to remember to instrument
 * itself is a node that eventually doesn't.
 */
export function traced(trace, node, fn, onProgress) {
  return async (state) => {
    trace.begin(node, state)
    onProgress?.(`▸ ${node}`)
    let update
    try {
      update = await fn(state)
    } catch (err) {
      trace.end(node, { refusal: { at: node, reason: 'node_threw', detail: err.message } }, { error: String(err.stack || err) })
      throw err
    }
    trace.end(node, update)
    return update
  }
}
