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
import { addComment } from './lib/jira.mjs'
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
function afterPatch(s) {
  if (s.escalation) {
    const canRetry = s.escalation.neededFiles?.length && (s.replans ?? 0) < MAX_REPLANS
    return canRetry ? 'planning' : 'refuse'
  }
  return s.refusal ? 'refuse' : 'verify'
}

function afterVerify(s) {
  if (s.refusal) return 'refuse'
  if (s.gate?.ok) return 'approve'
  if ((s.attempts ?? 0) >= MAX_REPAIR_ATTEMPTS) return 'refuse'
  return 'repair'
}

export function buildGraph({ budget, checkpointer, trace, dryRun = false, onProgress = () => {}, commentOnJira = true }) {
  // One wrapper, applied uniformly: a node that must remember to instrument itself eventually won't.
  const N = (name, fn) => (trace ? traced(trace, name, fn, onProgress) : fn)

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

  const g = new StateGraph(S)
    .addNode('intake', N('intake', intakeNode({ budget })))
    .addNode('locate', N('locate', locateNode({ budget, onProgress })))
    .addNode('planning', N('planning', planNode({ budget })))
    .addNode('reproduce', N('reproduce', reproduceNode({ budget, onProgress })))
    .addNode('patch', N('patch', patchNode({ budget, onProgress })))
    .addNode('verify', N('verify', verifyNode({ onProgress })))
    .addNode('repair', N('repair', repairNode({ budget, onProgress })))
    .addNode('approve', N('approve', approveNode()))
    .addNode('publish', N('publish', async (s) => ({ ...(await publishNode({ budget, dryRun })(s)), ledger: budget.report() })))
    .addNode('refuse', N('refuse', refuseNode))

    .addEdge(START, 'intake')
    .addConditionalEdges('intake', orRefuse('locate'), ['locate', 'refuse'])
    .addConditionalEdges('locate', orRefuse('planning'), ['planning', 'refuse'])
    .addConditionalEdges('planning', orRefuse('reproduce'), ['reproduce', 'refuse'])
    .addConditionalEdges('reproduce', orRefuse('patch'), ['patch', 'refuse'])
    .addConditionalEdges('patch', afterPatch, ['verify', 'planning', 'refuse'])
    .addConditionalEdges('verify', afterVerify, ['approve', 'repair', 'refuse'])
    .addConditionalEdges('approve', orRefuse('publish'), ['publish', 'refuse'])
    .addConditionalEdges('repair', orRefuse('verify'), ['verify', 'refuse'])   // the bounded loop
    .addEdge('publish', END)
    .addEdge('refuse', END)

  return g.compile({ checkpointer })
}
