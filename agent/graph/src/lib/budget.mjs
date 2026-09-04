// Per-run cost guard. Kept from Cody's design because the shape is right.
//
// Two ideas worth carrying over verbatim:
//
//   1. A per-run cap enforced CUMULATIVELY across phases, not per call. Otherwise a fix loop
//      quietly spends the whole month.
//   2. A FINALIZE RESERVE — USD held back from every earlier phase so the last step always has
//      budget to commit, push and open the PR. His comment says it best: "a starved finalize means
//      no PR (the run's only deliverable)".
//
// What was wrong on ESI2-3376 and is fixed here: the reserve was $8 of a $15 cap, so everything
// before finalize shared $7.00 — and `apply` alone needs more than that on Opus. It died with
// `error_max_budget_usd` at $7.13 mid-phase. The cap must be sized from the tier table, so the
// default here is derived, not guessed: fast phases are cents, so the cap is essentially
// (patch + repair loop) x Opus + reserve.

// The budget is dollars AND minutes. The target is a PR in under 20 minutes wall-clock (Cody's
// runs take hours); a node that would start with no time left refuses, and a Claude Code session
// is killed when the clock runs out rather than allowed to finish late.
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
  }

  elapsedMs() { return Date.now() - this.t0 }

  /** Milliseconds of wall-clock left before the run must stop starting new model work. */
  timeLeftMs() { return Math.max(0, this.maxMinutes * 60_000 - this.elapsedMs()) }

  /** Time a node may hold a Claude Code session: what is left, minus a reserve for verify+publish. */
  timeFor(node) {
    const reserveMs = (node === 'package' || node === 'publish') ? 0 : 3 * 60_000
    return Math.max(0, this.timeLeftMs() - reserveMs)
  }

  /** USD a pre-publish phase may still spend. */
  availableFor(node) {
    const isPublish = node === 'package' || node === 'publish'
    const ceiling = isPublish ? this.capUsd : this.capUsd - this.reserveUsd
    return Math.max(0, ceiling - this.spent)
  }

  canRun(node, estimateUsd = 0) {
    return this.availableFor(node) >= estimateUsd
  }

  charge(node, usd, meta = {}) {
    this.spent += usd
    this.ledger.push({ node, usd, at: new Date().toISOString(), ...meta })
    return this.spent
  }

  report() {
    const byNode = {}
    for (const e of this.ledger) byNode[e.node] = (byNode[e.node] || 0) + e.usd
    return { spent: this.spent, capUsd: this.capUsd, reserveUsd: this.reserveUsd, byNode, elapsedMs: this.elapsedMs(), maxMinutes: this.maxMinutes }
  }
}
