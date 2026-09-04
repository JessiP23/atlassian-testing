// Localization. Deterministic router first, cheap model to re-rank. NO codebase re-reading.
//
// This is the node that answers "my agent does not have to read the codebase every time".
// It reuses the router already built and measured in this repo:
//
//     6,258 files  ->  [BM25 + import graph + ticket->file history, 2.2s, $0]  ->  25 candidates
//                  ->  [Haiku re-rank, ~3s, ~$0.01]                            ->  5 files
//
// Measured on 449 held-out tickets and a 20-ticket model bench:
//     router alone, correct file in top 25 : 50.0%   (any-hit@25)
//     router alone, correct file in top  5 : 20.0%
//     + Haiku re-rank                      : 55.0%   <- ~3x on the number that matters
//     + Opus  re-rank                      : 60.0%   at 2x latency and ~5x price -> not worth it
//
// Contrast: on ESI2-3376 the agent had no router, so Opus 5 opened with `grep -rn "templateId"`,
// `find packages/... -type f`, and six more sweeps before it read a single relevant file. That
// exploration is what this node deletes.
//
// Why no embeddings/pgvector here (it was proposed, and it is a reasonable idea):
// we have the harness to answer it rather than assume. Query EXPANSION with an LLM was tried in
// this repo and measured at 9.6% term validity and ZERO lift (see src/expand.mjs, which keeps the
// negative result in its header so it is not retried). Embeddings over file summaries may well
// beat BM25 — but it costs a vector store, an embedding pass over 6,258 files, and a re-embed on
// every merge. So it belongs in Phase 2 behind `par eval`, not in the critical path on day one.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { converseJson } from '../lib/bedrock.mjs'
import { tierFor, estimateCost } from '../lib/models.mjs'

const exec = promisify(execFile)
const ROUTER_CLI = process.env.PAG_ROUTER_CLI || path.resolve(import.meta.dirname, '../../../src/cli.mjs')

// MEASURED (2026-09-02, 442 held-out tickets, real Jira text). The recall curve is why this is 50
// and not 25 — retrieval is cheap, so the candidate set should be as wide as the re-rank can read:
//
//     any-hit@1   11.5%      any-hit@50   61.5%   <- +11.8pp over k=25, for $0
//     any-hit@5   27.6%      any-hit@75   65.4%      (+3.8 — diminishing)
//     any-hit@25  49.8%      any-hit@100  69.5%      (+4.1, and a 100-item prompt starts to cost)
//
// 25.1% of tickets never surface a correct file inside the top 200 at all. That is the hard
// ceiling on this whole pipeline and no re-rank can recover it — which is exactly why `refuse` is
// a first-class terminal state rather than an error path.
//
// Single-file tickets — 36% of the corpus and the hardest case — gain the most: 29.2% -> 43.5%.
const CANDIDATE_K = Number(process.env.PAG_CANDIDATE_K || 50)

const SYSTEM = `You pick which files a ticket most likely needs changed.

You are given a ticket spec and a ranked candidate list with each file's exported symbols. The
candidates came from a deterministic retriever whose top-50 contains a correct file about 62% of
the time — so the right answer is often NOT present. Saying so is more useful than guessing.

The list is ordered by a lexical + import-graph + ticket-history score. That ordering is weak
evidence, not a ranking to defer to: the correct file is at rank 1 only 12% of the time and is
somewhere in 2-50 half the time. Read the whole list.

Rules:
- Prefer the file where the CAUSE lives over the file where the SYMPTOM appears.
- Pick at most 5. Fewer is better.
- confidence "low" if nothing in the list plausibly owns this behaviour.

Return JSON: {"picks":[{"path":str,"reason":str}],"confidence":"high"|"medium"|"low"}`

export function locateNode({ budget }) {
  return async (s) => {
    const tier = tierFor('rerank')
    const query = [s.spec.summary, ...(s.spec.acceptanceCriteria || [])].join(' ')

    // Deterministic, $0, ~2s. Reads .par/index.json — built once per merge, not per ticket.
    const { stdout } = await exec('node', [ROUTER_CLI, 'route', query, '--k', String(CANDIDATE_K), '--json'], {
      cwd: path.dirname(path.dirname(ROUTER_CLI)),
      maxBuffer: 1 << 24,
    })
    const candidates = JSON.parse(stdout)

    if (!candidates.length) {
      return { candidates: [], refusal: { at: 'locate', reason: 'no_candidates', detail: 'router returned nothing — is .par/index.json stale?' } }
    }

    const user = [
      `TICKET: ${s.spec.summary}`,
      `ACCEPTANCE: ${(s.spec.acceptanceCriteria || []).join(' | ')}`,
      '',
      'CANDIDATES (rank. path — exports):',
      ...candidates.map((c, i) => `${i + 1}. ${c.path} — ${(c.exports || []).slice(0, 12).join(', ') || '(none)'}`),
    ].join('\n')

    const { data, inTok, outTok } = await converseJson({
      model: tier.model, system: SYSTEM, user, maxTokens: tier.maxTokens,
    })
    budget.charge('rerank', estimateCost(tier, inTok, outTok), { model: tier.model, inTok, outTok })

    const picks = (data.picks || []).filter((p) => candidates.some((c) => c.path === p.path))
    if (!picks.length || data.confidence === 'low') {
      return {
        candidates, located: picks, confidence: 'low',
        refusal: {
          at: 'locate',
          reason: 'localization_failed',
          detail: `re-rank could not identify an owning file among 25 candidates. Top candidate was ${candidates[0].path}.`,
        },
      }
    }
    return { candidates, located: picks, confidence: data.confidence }
  }
}
