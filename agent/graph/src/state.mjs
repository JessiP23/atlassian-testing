// Graph state. One flat annotation; every node returns a partial of it.
//
// Design rule that keeps cost down: state holds IDENTIFIERS AND VERDICTS, never file bodies.
// A node that needs a file's content reads it from disk at the moment it needs it and lets it go.
// The moment file text lives in state it gets checkpointed, re-serialised, and — if it ever reaches
// a message list — resent on every subsequent call. That is how a $0.20 workflow becomes a $7 one.

import { Annotation } from '@langchain/langgraph'

const last = () => Annotation()

export const S = Annotation.Root({
  // ---- inputs -------------------------------------------------------------------------------
  issueKey: last(),          // "ESI2-3376"
  repo: last(),              // absolute path to the worktree this run owns
  baseBranch: last(),        // "main"
  prTargetBranch: last(),    // "qa"
  branchName: last(),        // "bug/ESI2-3376-<slug>" — created by the graph, never assumed
  baseSha: last(),           // resolved origin/<baseBranch> sha; keys the baseline snapshot

  // ---- intake -------------------------------------------------------------------------------
  ticket: last(),            // { summary, description, comments[], attachments[] } — redacted
  spec: last(),              // { summary, acceptanceCriteria[], constraints[], nonGoals[], riskNotes[], testPlan[] }

  // ---- localization -------------------------------------------------------------------------
  candidates: last(),        // router top-25: [{ path, score, why }]
  located: last(),           // rerank top-5: [{ path, reason }]
  confidence: last(),        // 'high' | 'medium' | 'low' — drives the admission gate

  // ---- plan ---------------------------------------------------------------------------------
  plan: last(),              // { impactedFiles[], steps[], newTests[], migrationNotes }

  // ---- evidence -----------------------------------------------------------------------------
  // The reproducing test, written before patch and frozen. `status: 'red'` means the runner saw it
  // fail on the pinned commit; `sha` is what verify checks so patch cannot have edited it.
  repro: last(),             // { status:'red'|'none', file, sha, rung, cmd, redExcerpt, reason }
  evidence: last(),          // { reproGreen, greenExcerpt } — written by verify

  // ---- patch / verify loop ------------------------------------------------------------------
  changed: last(),           // real `git diff --name-only` result, post-patch
  diffStat: last(),          // { files, insertions, deletions }
  scope: last(),             // { owners[], typeConsumers[], plan[] } from lib/scope.mjs
  gate: last(),              // { ok, target, summary, newFailures[], preExisting[], logTail }
  attempts: Annotation({ reducer: (a, b) => (b ?? 0), default: () => 0 }),

  // ---- re-plan ------------------------------------------------------------------------------
  // When patch discovers the fix lives in a file the plan never allowed, its analysis is worth
  // keeping: it has already read the code and named the file. `escalation` carries that forward so
  // planning can widen the allowlist instead of the run being thrown away.
  escalation: last(),   // { text, neededFiles[] }
  replans: Annotation({ reducer: (a, b) => (b ?? 0), default: () => 0 }),

  // ---- output -------------------------------------------------------------------------------
  pr: last(),                // { title, body, testNotes, rolloutNotes }
  prUrl: last(),

  // ---- hand-over ----------------------------------------------------------------------------
  // Set by the `handover` node when the run reaches its deadline (or its repair limit) with the
  // gate still red. It does NOT mean failure: publish turns it into an explicitly INCOMPLETE draft
  // PR carrying the diff, the evidence and the remaining failures, because a human with a branch
  // to finish is worth more than a Jira comment with a log tail. See lib/budget.mjs.
  incomplete: last(),        // { reason, at }
  outOfTime: last(),         // repair setting this means "not enough clock to try", not "failed"
  secrets: last(),           // findings from lib/secrets.mjs when the diff carried a credential

  // ---- control ------------------------------------------------------------------------------
  // Terminal reason when the graph refuses. A refusal is a SUCCESSFUL outcome of the workflow:
  // Cody's triage prompt had no refusal path at all ("No human will answer; you'll make a
  // reasonable, documented decision later"), which is why a low-confidence ticket still burned a
  // full Opus apply. Refusing early is the cheapest correct answer.
  refusal: last(),           // { at, reason, detail }
  ledger: last(),            // budget.report()
})

export const MAX_REPAIR_ATTEMPTS = Number(process.env.PAG_MAX_REPAIR || 3)
export const MAX_REPLANS = Number(process.env.PAG_MAX_REPLANS || 1)
