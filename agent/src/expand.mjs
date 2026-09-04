// Query expansion. The step where a model genuinely earns its cost.
//
// The gap the deterministic router cannot close is VOCABULARY. A ticket says "the
// dropdown doesn't show any options"; the code says `Select`, `MenuItem`, `renderOptions`,
// `useOptionsQuery`. No tokenizer bridges that, because the words simply differ. A model
// bridges it in one cheap call by emitting the identifiers a developer would grep for.
//
// It also classifies intent, which is what admission control needs: a ticket the model
// reads as a product question rather than a code defect should never reach a coder agent.
//
// Everything here degrades to the deterministic path on failure. The LLM is an
// accelerator, never a dependency.

// MEASURED RESULT - 2026-09-02, 15-ticket sample, Groq openai/gpt-oss-120b:
//
//   deterministic     any-hit@25  20.0%
//   + LLM expansion   any-hit@25  20.0%   <- zero lift
//   derived terms that exist in the repo: 18/187 (9.6%)
//
// The hypothesis was that a model could bridge the vocabulary gap between how a reporter
// describes a symptom and how the code names things. It cannot, at least not this way:
// asked for identifiers, the model INVENTS plausible ones (`handleImport`, `importService`,
// `useImportMutation`) rather than recalling real ones, because it has never seen this
// codebase. Nine out of ten terms match nothing, and BM25 scores a term that exists
// nowhere as zero - so the expansion is almost entirely noise.
//
// Kept, not deleted, because the negative result is worth preserving and because the
// verified-term path would become useful if the prompt were ever given real symbol
// candidates to choose FROM rather than asked to generate them. It is OFF by default.
//
// Re-rank (rerank.mjs) is a different matter: it CHOOSES from real paths we supply, so it
// cannot invent, and it demonstrably corrected the ranking on ESI2-3376.

import { complete, parseJson, isEnabled } from './lib/llm.mjs'

const SYSTEM = `You translate software tickets into codebase search terms.

You are given a ticket and a list of the top-level packages in a monorepo. Return ONLY a
JSON object, no prose:

{
  "intent": "bug" | "feature" | "chore" | "perf" | "question",
  "codeTerms": ["identifier-style terms a developer would grep for"],
  "domainTerms": ["domain nouns from the product, lowercase"],
  "packages": ["package names from the provided list, most likely first"],
  "actionable": true | false,
  "reason": "one short clause - why actionable or not"
}

Rules for codeTerms - this is the important field:
- Emit the names that likely EXIST IN CODE, not the words the ticket used.
  "dropdown shows nothing" -> ["Select","MenuItem","options","useOptions","renderOptions"]
  "page is slow to load"   -> ["useQuery","fetchPolicy","useMemo","virtualized","refetch"]
  "cannot save the form"   -> ["onSubmit","handleSave","mutation","validate","useForm"]
- Prefer specific identifiers over generic ones. Skip "component", "service", "handler".
- 8 to 15 terms. camelCase or PascalCase as they would appear in source.
- If the ticket already names files, symbols or GraphQL operations, include them verbatim.

Set actionable=false when the ticket has no reproducible defect, asks a question, needs a
product decision, or is too vague to locate - and say so in one clause.`

/**
 * @param {string} ticketText
 * @param {string[]} packageNames
 * @returns {Promise<null|{intent:string,codeTerms:string[],domainTerms:string[],packages:string[],actionable:boolean,reason:string}>}
 */
export async function expandQuery(ticketText, packageNames = []) {
  if (!isEnabled() || !ticketText) return null

  // Cap the ticket: the tail of a long comment thread is scheduling chatter, and this
  // call is priced per token.
  const ticket = String(ticketText).slice(0, 6000)
  const pkgs = packageNames.slice(0, 120).join(', ')

  const raw = await complete({
    system: SYSTEM,
    user: `PACKAGES:\n${pkgs}\n\nTICKET:\n${ticket}`,
    // Reasoning models get this multiplied up in llm.mjs - see isReasoningModel().
    maxTokens: 900,
    json: true,
  })
  const j = parseJson(raw)
  if (!j) return null

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20) : [])
  return {
    intent: typeof j.intent === 'string' ? j.intent : 'bug',
    codeTerms: arr(j.codeTerms),
    domainTerms: arr(j.domainTerms),
    packages: arr(j.packages),
    actionable: j.actionable !== false,
    reason: typeof j.reason === 'string' ? j.reason.slice(0, 200) : '',
  }
}

/**
 * Fold the expansion back into a search string.
 *
 * Terms VERIFIED to exist in the codebase get heavy repetition - they are as reliable as
 * an identifier the reporter quoted, and BM25 scores on term frequency. Unverified terms
 * are included once, not zero times: an invented name still shares word stems with real
 * ones ("import", "template", "validate"), so it carries weak lexical signal even when the
 * exact identifier does not exist.
 *
 * The original ticket text is always kept - dropping it would discard every signal the
 * model failed to notice.
 *
 * @param {string} ticketText
 * @param {object|null} expansion
 * @param {{verified:string[], unverified:string[]}|null} [split] from Router.verifyTerms()
 */
export function buildQuery(ticketText, expansion, split = null) {
  if (!expansion) return ticketText

  const verified = split ? split.verified : []
  const unverified = split ? split.unverified : expansion.codeTerms

  const parts = [ticketText]
  // 6x for verified: these are effectively hard signals.
  for (let i = 0; i < 6; i++) parts.push(verified.join(' '))
  parts.push(unverified.join(' '))
  parts.push(expansion.domainTerms.join(' '))
  return parts.join(' ')
}
