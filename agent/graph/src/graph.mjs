// The workflow. Phase boundaries are edges; the work inside a phase is a node.
//
//   intake ──▶ locate ──▶ planning ──▶ reproduce ──▶ patch ──▶ verify ──┬─(green)──▶ approve ──▶ publish ──▶ END
//                                      (writes the failing test, freezes it; verify re-runs it first)
//                            ▲            │
//                            └────────────┘  patch escalated: it named the file the fix needs.
//                              re-plan ×1    Widen the allowlist and hand the work back.
//     │          │          │        │                 │
//     │          │          │        │                 └─(new failures, attempts<N)──▶ repair ──┐
//     │          │          │        │                                                          │
//     │          │          │        │                 ┌────────────────────────────────────────┘
//     │          │          │        │                 ▼
//     │          │          │        │                 └─(out of clock/attempts, diff exists)──▶ handover ──▶ publish
//     │          │          │        │
//     └──────────┴──────────┴────────┴──────────────▶ refuse ──▶ END
//
// Every node can route to `refuse`, and refusing is a SUCCESSFUL terminal state — the workflow
// answering "not this one, and here is why" for a few cents. Cody's triage prompt had no refusal
// path at all ("No human will answer; you'll make a reasonable, documented decision later"), which
// is why an under-specified or mis-localized ticket still paid for a full Opus apply.
//
// Deliberately NOT modelled as graph nodes: individual tool calls and file edits. Each graph
// transition writes a checkpoint, and one edit session is hundreds of tool calls. The inner loop
// belongs to Claude Code (see nodes/patch.mjs); the graph owns only what must be durable,
// separately budgeted, and independently traced.

// NOTE: LangGraph forbids a node name that collides with a state channel name, so the planning
// node is `planning` while the state field it writes is `plan`. Renaming either one breaks compile
// with "X is already being used as a state attribute".
import { StateGraph, START, END } from '@langchain/langgraph'
import { S, MAX_REPAIR_ATTEMPTS, MAX_REPLANS } from './state.mjs'
import { intakeNode } from './nodes/intake.mjs'
import { locateNode } from './nodes/locate.mjs'
import { planNode } from './nodes/plan.mjs'
import { reproduceNode } from './nodes/reproduce.mjs'
import { patchNode } from './nodes/patch.mjs'
import { verifyNode } from './nodes/verify.mjs'
import { repairNode } from './nodes/repair.mjs'
import { publishNode } from './nodes/publish.mjs'
import { approveNode, REQUIRE_APPROVAL } from './nodes/approve.mjs'
import { addComment, AGENT_MARK } from './lib/jira.mjs'
import { traced } from './lib/trace.mjs'

/** Any node that set `refusal` short-circuits to the terminal explainer. */
const orRefuse = (next) => (s) => (s.refusal ? 'refuse' : next)

// One re-plan, and only when patch actually named files it needs.
//
// Why this edge exists: on ESI2-3379 the patch step spent $1.09 proving the authorization gate sat
// upstream of every file the plan allowed, named the exact file and test that needed changing, and
// then the run was thrown away — because the allowlist was fixed before anyone knew where the bug
// was. The diagnosis is the expensive part and it was already paid for. Re-planning with the named
// files costs cents.
//
// Bounded at MAX_REPLANS so a run cannot ping-pong between planning and patch, and an escalation
// that names nothing usable goes straight to refuse — there is nothing to widen.
export function afterPatch(s) {
  if (s.escalation) {
    const canRetry = s.escalation.neededFiles?.length && (s.replans ?? 0) < MAX_REPLANS
    return canRetry ? 'planning' : 'refuse'
  }
  return s.refusal ? 'refuse' : 'verify'
}

// The same edge, one step earlier. `reproduce` is the first node that reads the code with the
// ticket's symptom in hand; when it finds the plan's files cannot produce that symptom it names the
// file that does, and the plan is redone around it — before an Opus patch session is paid for and
// before a red test against the wrong file is frozen. Same bound, same refuse path.
export function afterReproduce(s) {
  if (s.escalation) {
    const canRetry = s.escalation.neededFiles?.length && (s.replans ?? 0) < MAX_REPLANS
    return canRetry ? 'planning' : 'refuse'
  }
  return s.refusal ? 'refuse' : 'patch'
}

// Whether a red gate is worth another repair attempt, or whether it is time to hand the work to a
// human. THREE answers, and the third is the one that was missing:
//
//   repair    attempts left AND enough clock for an Opus session to read a file and edit it
//   handover  out of attempts or out of clock, but there IS a diff — publish it as INCOMPLETE
//   refuse    nothing to hand over (no diff, or the refusal is fatal: a leaked credential, a
//             tampered repro, the wrong remote)
//
// Before this, KAN-6 spent 20 minutes producing a correct fix and then deleted it, because the
// clock ran out during repair and `time_budget` was a refusal. The expensive part of a run is the
// diagnosis; discarding it at the last step is the single worst thing this workflow can do.
const SALVAGE = process.env.PAG_HANDOVER !== '0'

export /**
 * Is every remaining failure inside the frozen reproducing test?
 *
 * If so, `repair` cannot fix any of them — the file is hash-checked and it is told it may not edit
 * it — so sending it there buys nothing. On ESI2-3393 it went three times, spent $0.75 and 130
 * seconds, and each attempt correctly answered "the failures are in the file I am not allowed to
 * edit". Recognising that on the first pass turns three useless Opus sessions into an immediate
 * hand-over with an accurate reason.
 */
function onlyFrozenFileFails(s) {
  const f = s.gate?.failures || []
  if (!f.length || !s.repro?.file) return false
  const frozen = String(s.repro.file)
  return f.every((x) => x.file && (frozen.endsWith(x.file) || x.file.endsWith(frozen) || x.file === frozen))
}

export function afterVerifyWith(budget) {
  return (s) => {
    if (s.refusal) return 'refuse'
    if (s.gate?.ok) return 'approve'
    if (onlyFrozenFileFails(s)) return SALVAGE && s.changed?.length ? 'handover' : 'refuse'
    const attemptsLeft = (s.attempts ?? 0) < MAX_REPAIR_ATTEMPTS
    const clock = budget.timeFor('repair') >= 45_000
    if (attemptsLeft && clock) return 'repair'
    return SALVAGE && s.changed?.length ? 'handover' : 'refuse'
  }
}

export function afterRepair(s) {
  if (s.refusal) return 'refuse'
  if (s.outOfTime) return SALVAGE && s.changed?.length ? 'handover' : 'refuse'
  return 'verify'
}

export function buildGraph({ budget, checkpointer, trace, dryRun = false, onProgress = () => {}, commentOnJira = true }) {
  // One wrapper, applied uniformly: a node that must remember to instrument itself eventually won't.
  const inner = (name, fn) => (trace ? traced(trace, name, fn, onProgress) : fn)
  // Per-phase wall time, recorded once here so the PR footer can show where the 20 minutes went
  // ("reproduce 214s · patch 186s · verify 41s") — the number you actually tune the budget on.
  const N = (name, fn) => {
    const wrapped = inner(name, fn)
    return async (s) => {
      const t0 = Date.now()
      budget.startPhase(name)
      try { return await wrapped(s) } finally { budget.recordPhase(name, Date.now() - t0) }
    }
  }

  const refuseNode = async (s) => {
    // An escalation that reaches here either named nothing usable or already had its one re-plan.
    // It carries the most valuable output of the whole run — a diagnosis with file:line — so it
    // must be reported as such, not mislabelled as a gate failure (patch sets refusal to null when
    // it escalates, so the fallback below would otherwise claim the gate never passed).
    const r = s.refusal
      || (s.escalation && {
        at: 'patch',
        reason: (s.replans ?? 0) > 0 ? 'escalated_after_replan' : 'escalated_no_target',
        detail: (s.replans ?? 0) > 0
          ? `Re-planned once with ${s.escalation.neededFiles?.join(', ') || 'the named files'} and it escalated again — a human should read the analysis below.\n\n${s.escalation.text}`
          : `Escalated without naming a file the workflow could act on.\n\n${s.escalation.text}`,
      })
      || { at: 'verify', reason: 'gate_never_passed', detail: s.gate?.summary || 'unknown' }
    const ledger = budget.report()

    // A refusal is only useful if it reaches a human where they already are.
    if (commentOnJira && !dryRun) {
      const lines = [
        `${AGENT_MARK}`,
        `panda-agent-graph stopped at \`${r.at}\`: ${r.reason}`,
        '',
        String(r.detail || '').slice(0, 20000),
        '',
        s.located?.length ? `Files it had narrowed to: ${s.located.map((p) => p.path).join(', ')}` : '',
        s.gate ? `Gate: ${s.gate.summary}` : '',
        s.gate?.newFailures?.length ? `New failures: ${s.gate.newFailures.slice(0, 10).join(' | ')}` : '',
        '',
        `Spent $${ledger.spent.toFixed(4)} of $${ledger.capUsd}. No branch pushed, no PR opened.`,
      ].filter(Boolean)
      await addComment(s.issueKey, lines.join('\n')).catch((e) => onProgress(`jira comment failed: ${e.message}`))
    }
    onProgress(`REFUSED at ${r.at}: ${r.reason} — ${r.detail || ''}`)
    return { refusal: r, ledger }
  }

  // A deliberately tiny node: it records WHY the run is handing over and nothing else. Publish
  // reads `incomplete` and changes the title, the label, the first block of the body and the Jira
  // comment accordingly. Keeping the decision in its own node means it shows up in the timeline as
  // its own step, so a reviewer of the run can see exactly where the clock ran out.
  const handoverNode = async (s) => {
    const left = Math.round(budget.timeLeftMs() / 1000)
    const reason = onlyFrozenFileFails(s)
      ? `Every remaining gate failure is inside the frozen reproducing test, which no step may edit — `
        + `the product fix itself is green. Clear the lint on that test, or delete it, and the gate passes.`
      : (s.attempts ?? 0) >= MAX_REPAIR_ATTEMPTS && left > 60
      ? `It used all ${MAX_REPAIR_ATTEMPTS} repair attempts and the gate is still red.`
      : `It reached the ${budget.maxMinutes}-minute deadline with ${left}s left — not enough to attempt another fix and still publish.`
    onProgress(`HANDOVER: ${reason} Publishing the diff as an incomplete draft.`)
    return { incomplete: { reason, at: 'verify', timeLeftMs: budget.timeLeftMs() }, ledger: budget.report() }
  }

  const g = new StateGraph(S)
    .addNode('intake', N('intake', intakeNode({ budget })))
    .addNode('locate', N('locate', locateNode({ budget, onProgress })))
    .addNode('planning', N('planning', planNode({ budget, onProgress })))
    .addNode('reproduce', N('reproduce', reproduceNode({ budget, onProgress })))
    .addNode('patch', N('patch', patchNode({ budget, onProgress })))
    .addNode('verify', N('verify', verifyNode({ budget, onProgress })))
    .addNode('repair', N('repair', repairNode({ budget, onProgress })))
    .addNode('handover', N('handover', handoverNode))
    .addNode('approve', N('approve', approveNode()))
    .addNode('publish', N('publish', async (s) => ({ ...(await publishNode({ budget, dryRun })(s)), ledger: budget.report() })))
    .addNode('refuse', N('refuse', refuseNode))

    .addEdge(START, 'intake')
    .addConditionalEdges('intake', orRefuse('locate'), ['locate', 'refuse'])
    .addConditionalEdges('locate', orRefuse('planning'), ['planning', 'refuse'])
    .addConditionalEdges('planning', orRefuse('reproduce'), ['reproduce', 'refuse'])
    .addConditionalEdges('reproduce', afterReproduce, ['patch', 'planning', 'refuse'])
    .addConditionalEdges('patch', afterPatch, ['verify', 'planning', 'refuse'])
    .addConditionalEdges('verify', afterVerifyWith(budget), ['approve', 'repair', 'handover', 'refuse'])
    .addConditionalEdges('approve', orRefuse('publish'), ['publish', 'refuse'])
    .addConditionalEdges('repair', afterRepair, ['verify', 'handover', 'refuse'])   // the bounded loop
    .addEdge('handover', 'publish')
    .addEdge('publish', END)
    .addEdge('refuse', END)

  return g.compile({ checkpointer })
}
