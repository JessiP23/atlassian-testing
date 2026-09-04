// Re-rank. Turns 50 candidates into the 3-5 files a coder agent actually opens.
//
// This is the second and last place a model belongs. It sees only candidate PATHS and
// their EXPORTED SYMBOL NAMES - never file contents - so the call stays around 3-5k
// tokens regardless of repository size. That bound is the whole cost argument: an agent
// that explores a monorepo pays per ticket forever, while this pays a fixed few cents.

import { complete, parseJson, isEnabled } from './lib/llm.mjs'

const SYSTEM = `You pick which files a developer must open to resolve a ticket.

You get the ticket and a numbered candidate list. Each candidate shows its path, its
package, and some of the symbols it exports. You cannot see file contents.

Return ONLY JSON:

{
  "picks": [{ "n": <candidate number>, "role": "cause" | "callsite" | "test" | "config", "why": "one short clause" }],
  "layerNote": "one clause on which layer the cause most likely sits in",
  "confidence": "high" | "medium" | "low"
}

Rules:
- 1 to 5 picks, ordered most important first. Fewer is better than padding.
- Consider that the SYMPTOM and the CAUSE often sit in different layers. A slow page may
  be caused by the data-fetching layer, not the component that renders it. If the
  candidates include both, prefer the cause and mark the component as "callsite".
- Only pick from the numbered list. Never invent a path.
- confidence=low when no candidate plausibly contains the cause - that is a useful answer,
  not a failure.`

function candidateBlock(candidates, index) {
  const byPath = new Map(index.files.map((f) => [f.path, f]))
  return candidates
    .map((c, i) => {
      const f = byPath.get(c.path)
      const syms = (f?.exports || []).slice(0, 10).join(', ')
      const gql = (f?.gqlOps || []).slice(0, 5)
      const extra = gql.length ? `  gql: ${gql.join(', ')}` : ''
      return `${i + 1}. ${c.path}\n   pkg: ${c.pkg}\n   exports: ${syms || '(none detected)'}${extra}`
    })
    .join('\n')
}

/**
 * @param {string} ticketText
 * @param {{path:string,pkg:string}[]} candidates  router output, top ~50 (see the recall curve
 *   in graph/src/nodes/locate.mjs — k=50 carries 61.5% any-hit against k=25's 49.8%, and the
 *   extra 25 rows cost roughly 2k prompt tokens, i.e. fractions of a cent on Haiku)
 * @param {{files:any[]}} index
 * @returns {Promise<null|{picks:{path:string,role:string,why:string}[],layerNote:string,confidence:string}>}
 */
export async function rerank(ticketText, candidates, index) {
  if (!isEnabled() || !candidates.length) return null

  const raw = await complete({
    system: SYSTEM,
    user: `TICKET:\n${String(ticketText).slice(0, 4000)}\n\nCANDIDATES:\n${candidateBlock(candidates, index)}`,
    maxTokens: 1200,
    json: true,
  })
  const j = parseJson(raw)
  if (!j || !Array.isArray(j.picks)) return null

  const picks = []
  for (const p of j.picks.slice(0, 5)) {
    const n = Number(p?.n)
    // Silently drop hallucinated indices rather than trusting the model's numbering.
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) continue
    picks.push({
      path: candidates[n - 1].path,
      pkg: candidates[n - 1].pkg,
      role: typeof p.role === 'string' ? p.role : 'cause',
      why: typeof p.why === 'string' ? p.why.slice(0, 160) : '',
    })
  }
  if (!picks.length) return null

  return {
    picks,
    layerNote: typeof j.layerNote === 'string' ? j.layerNote.slice(0, 200) : '',
    confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'medium',
  }
}
