// Per-run guard on BOTH scarce resources: dollars and wall-clock minutes.
//
// Two ideas kept from Cody's design because the shape is right:
//
//   1. A per-run cap enforced CUMULATIVELY across phases, not per call. Otherwise a fix loop
//      quietly spends the whole month.
//   2. A FINALIZE RESERVE — USD held back from every earlier phase so the last step always has
//      budget to commit, push and open the PR. His comment says it best: "a starved finalize means
//      no PR (the run's only deliverable)".
//
// ---------------------------------------------------------------------------------------------
// THE CLOCK, and why it is shaped like this
//
// The target is a PR inside PAG_MAX_MINUTES (20), consistently, for every ticket. The first
// version enforced that with one number: "if under 3 minutes remain, refuse". KAN-6 shows why that
// is not enough — the witness spent 566s of a 1200s budget, patch and verify took the rest, and
// repair started with 149s and refused `time_budget`. The run paid for a correct fix and threw it
// away at the last step. A deadline that produces nothing at minute 20 is worse than no deadline.
//
// So time is budgeted the way money already was: every phase declares
//
//   ceilMs  the most it may ever hold, however much clock is left  (a phase that wants 12 minutes
//           is a phase whose prompt is wrong, not one that deserves the run)
//   needMs  what the phases AFTER it must be left, so the deliverable survives
//
// and `timeFor(node)` hands out `min(ceilMs, timeLeft - downstream needs)`. An early phase can
// therefore never eat the clock that publish needs, and a late phase automatically gets whatever
// the earlier ones did not use. Nothing needs tuning per ticket; the arithmetic adapts.
//
// The one guarantee this buys: a run always reaches `publish` with time to push. When the gate is
// still red at the deadline the work is published as an INCOMPLETE draft (nodes/publish.mjs) —
// a human gets the branch, the diff and the evidence instead of a Jira comment.

// Declared in execution order. `needMs` is the TYPICAL cost of that phase, not its worst case:
// reserving worst cases for everything downstream starves the phase in hand for a run that will
// not happen. Overruns are absorbed by the next phase's own min().
export const PHASE_ORDER = ['intake', 'locate', 'planning', 'reproduce', 'patch', 'verify', 'repair', 'package', 'publish']

export const PHASES = {
  intake:    { ceilMs:  45_000, needMs:  20_000 },
  locate:    { ceilMs:  60_000, needMs:  15_000 },
  planning:  { ceilMs:  45_000, needMs:  20_000 },
  reproduce: { ceilMs: Number(process.env.PAG_REPRO_MINUTES || 6) * 60_000, needMs:  90_000 },
  patch:     { ceilMs: Number(process.env.PAG_PATCH_MINUTES || 7) * 60_000, needMs: 210_000 },
  verify:    { ceilMs: 240_000, needMs: 120_000 },
  repair:    { ceilMs: 180_000, needMs:      0 },   // optional phase: reserves nothing for itself
  package:   { ceilMs:  60_000, needMs:  20_000 },
  publish:   { ceilMs: 180_000, needMs:      0 },
}

/** Milliseconds that must still be on the clock when `node` hands over. */
export function downstreamMs(node) {
  const i = PHASE_ORDER.indexOf(node)
  if (i === -1) return 60_000
  return PHASE_ORDER.slice(i + 1).reduce((t, n) => t + (PHASES[n]?.needMs || 0), 0)
}

export class Budget {
  constructor({
    capUsd = Number(process.env.PAG_CAP_USD || 30),
    reserveUsd = Number(process.env.PAG_RESERVE_USD || 4),
    maxMinutes = Number(process.env.PAG_MAX_MINUTES || 20),
  } = {}) {
    this.capUsd = capUsd
    this.reserveUsd = reserveUsd
    this.maxMinutes = maxMinutes
    this.t0 = Date.now()
    this.spent = 0
    this.ledger = []
    this.phases = []          // { node, ms } — what each phase actually took, for the PR footer
  }

  elapsedMs() { return Date.now() - this.t0 }

  /** Wall-clock left before the run must stop. */
  timeLeftMs() { return Math.max(0, this.maxMinutes * 60_000 - this.elapsedMs()) }

  pastDeadline() { return this.timeLeftMs() <= 0 }

  /**
   * How long `node` may run: its own ceiling, capped by what is left after reserving the phases
   * that come after it. `publish` is never reserved against — it is the deliverable.
   */
  timeFor(node) {
    const p = PHASES[node]
    const left = this.timeLeftMs()
    if (!p) return Math.max(0, left - 60_000)
    return Math.max(0, Math.min(p.ceilMs, left - downstreamMs(node)))
  }

  /** True when `node` has enough clock to be worth starting at all. */
  hasTimeFor(node, minMs = 60_000) { return this.timeFor(node) >= minMs }

  /** USD a pre-publish phase may still spend. */
  availableFor(node) {
    const isPublish = node === 'package' || node === 'publish'
    const ceiling = isPublish ? this.capUsd : this.capUsd - this.reserveUsd
    return Math.max(0, ceiling - this.spent)
  }

  canRun(node, estimateUsd = 0) { return this.availableFor(node) >= estimateUsd }

  charge(node, usd, meta = {}) {
    this.spent += usd
    this.ledger.push({ node, usd, at: new Date().toISOString(), ...meta })
    return this.spent
  }

  /** Called by the trace wrapper: what each phase actually cost in wall time. */
  recordPhase(node, ms) { this.phases.push({ node, ms }) }

  report() {
    const byNode = {}
    for (const e of this.ledger) byNode[e.node] = (byNode[e.node] || 0) + e.usd
    return {
      spent: this.spent, capUsd: this.capUsd, reserveUsd: this.reserveUsd, byNode,
      elapsedMs: this.elapsedMs(), maxMinutes: this.maxMinutes,
      timeLeftMs: this.timeLeftMs(), phases: this.phases,
    }
  }
}
