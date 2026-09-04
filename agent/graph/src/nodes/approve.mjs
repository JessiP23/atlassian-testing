// Human approval gate. Deliberately an EMPTY node containing nothing but interrupt().
//
// This shape is forced by how LangGraph checkpoints work, and getting it wrong is subtle:
// checkpoints are written per SUPERSTEP, not inside a node, and the docs are explicit that on
// resume "any code that ran before the interrupt will execute again". So an interrupt() placed
// inside the patch node would re-run the entire 20-minute Opus patch every time a human clicked
// approve. The gate therefore lives in its own node with no side effects at all.
//
// Off by default: gating every run on a human defeats the point. Turn it on while the system is
// earning trust (PAG_REQUIRE_APPROVAL=1), then turn it off per-project once the eval numbers hold.

import { interrupt } from '@langchain/langgraph'

export const REQUIRE_APPROVAL = process.env.PAG_REQUIRE_APPROVAL === '1'

export function approveNode() {
  return async (s) => {
    if (!REQUIRE_APPROVAL) return {}

    // Everything a reviewer needs to say yes or no, and nothing more. Resumed with
    //   graph.invoke(new Command({ resume: { approved: true } }), { configurable: { thread_id } })
    const answer = interrupt({
      issueKey: s.issueKey,
      summary: s.spec?.summary,
      files: s.changed,
      diffStat: s.diffStat,
      gate: s.gate?.summary,
      branch: s.branchName,
      spent: s.ledger?.spent,
    })

    if (answer && answer.approved === false) {
      return { refusal: { at: 'approve', reason: 'rejected_by_human', detail: answer.reason || 'no reason given' } }
    }
    return {}
  }
}
