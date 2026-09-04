// `par hint <ISSUE-KEY>` - the integration point.
//
// Produces a markdown block that drops straight into an existing coding agent's triage
// phase. This is the whole point of the router: rather than building a second agent, hand
// the one that already works a ranked starting point instead of nothing.
//
// Measured on 449 held-out tickets: a correct file lands in the top 25 about half the
// time, at MRR ~0.19. So this is not an oracle and must never be presented as one - the
// block below says "candidates", gives a confidence verdict, and explicitly tells the
// consuming agent it may ignore the list. An agent that trusts a wrong hint is worse than
// an agent with no hint; an agent that starts from 25 good candidates instead of 6,000
// files is dramatically cheaper at identical correctness.
//
// Exit codes are for shell gating:
//   0  confident   - hint is worth injecting
//   2  low         - hint emitted but flagged; caller may skip injection
//   1  error

import fs from 'node:fs'
import { Router, buildHistory } from './router.mjs'
import { baseTokenize, makeTokenizer } from './lib/tokenize.mjs'
import { deriveStopwords, deriveTicketStopwords } from './lib/stopwords.mjs'
import { jiraConfig, probe } from './jira.mjs'
import { redact } from './lib/redact.mjs'
import { adfToText } from './lib/adf.mjs'

const FIELDS = 'summary,description,comment,issuetype,labels'

async function fetchIssueText(key) {
  const cfg = jiraConfig()
  const res = await fetch(`${cfg.url}/rest/api/2/issue/${key}?fields=${FIELDS}`, {
    headers: { authorization: cfg.auth, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Jira ${res.status} for ${key}: ${(await res.text()).slice(0, 200)}`)
  const issue = await res.json()
  const f = issue.fields || {}
  const parts = [issue.key, f.summary || '', adfToText(f.description)]
  for (const c of (f.comment?.comments || []).slice(0, 6)) parts.push(adfToText(c.body))
  const { text } = redact(parts.join('\n'))
  return {
    key: issue.key,
    summary: f.summary || '',
    type: f.issuetype?.name || '',
    text: text.replace(/\s+/g, ' ').slice(0, 8000).trim(),
  }
}

function buildRouter(indexFile, historyFile) {
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  const { stop } = deriveStopwords(index.files, baseTokenize)
  const tok = makeTokenizer(stop)

  let history = null
  let ticketStop = new Set()
  if (fs.existsSync(historyFile)) {
    const samples = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
    ticketStop = deriveTicketStopwords(samples, tok, 0.12).stop
    const queryTok = (t) => tok(t).filter((x) => !ticketStop.has(x))
    history = buildHistory(samples, queryTok)
  }
  return { index, router: new Router(index, history, {}, ticketStop) }
}

/**
 * @param {object} o
 * @param {string} o.key           Jira issue key
 * @param {string} [o.text]        skip Jira and use this text directly
 * @param {boolean} [o.useLlm]     expand the query with a model first
 * @param {boolean} [o.useRerank]  ask a model to pick the top few
 * @param {number} [o.k]
 */
export async function hint({
  key,
  text: providedText,
  useLlm = false,
  useRerank = false,
  k = 25,
  indexFile = '.par/index.json',
  historyFile = '.par/history.json',
}) {
  const { index, router } = buildRouter(indexFile, historyFile)

  let ticket = { key, summary: '', type: '', text: providedText || '' }
  if (!providedText) {
    const p = await probe(jiraConfig())
    if (!p.auth) throw new Error('Jira auth failed - run `par doctor`')
    ticket = await fetchIssueText(key)
  }
  if (!ticket.text) throw new Error(`no usable text for ${key}`)

  // Fail loudly on a misconfiguration. The LLM steps degrade silently by design - that is
  // correct in production, where a provider outage must not break a run - but when a human
  // explicitly passes --llm, silence looks like the flag is broken rather than unconfigured.
  if ((useLlm || useRerank) && (process.env.LLM_PROVIDER || 'none') === 'none') {
    console.error('  WARNING: --llm/--rerank requested but LLM_PROVIDER is "none".')
    console.error('  No model will be called. Set LLM_PROVIDER in .env (see .env.example).')
  }

  let query = ticket.text
  let expansion = null
  let termSplit = null
  if (useLlm) {
    const { expandQuery, buildQuery } = await import('./expand.mjs')
    expansion = await expandQuery(ticket.text, index.packages.map((p) => p.name))
    if (expansion) {
      // Check the model's invented identifiers against the real symbol table before
      // trusting them - see Router.verifyTerms().
      termSplit = router.verifyTerms(expansion.codeTerms)
      query = buildQuery(ticket.text, expansion, termSplit)
    } else if ((process.env.LLM_PROVIDER || 'none') !== 'none') {
      console.error('  WARNING: expansion call failed - set LLM_DEBUG=1 to see why.')
    }
  }

  const assessment = router.assess(query)
  const ranked = router.route(query, k)

  let reranked = null
  if (useRerank && ranked.length) {
    const { rerank } = await import('./rerank.mjs')
    reranked = await rerank(ticket.text, ranked, index)
  }

  return { ticket, expansion, termSplit, assessment, ranked, reranked }
}

/** Render the markdown block a consuming agent reads. */
export function renderHint({ ticket, expansion, termSplit, assessment, ranked, reranked }) {
  const L = []
  L.push(`## Router hint for ${ticket.key}`)
  L.push('')
  L.push('Generated by panda-agent-router from a static index of the repo (no model was')
  L.push('given the codebase). These are CANDIDATES, not conclusions.')
  L.push('')
  L.push('Reliability, measured on 449 historical tickets: a correct file appears in this')
  L.push('list about 50% of the time, typically around position 5. **If the list does not')
  L.push('contain a plausible cause, ignore it entirely and investigate normally.** Do not')
  L.push('force a fix into a listed file.')
  L.push('')

  const conf = assessment.confident ? 'CONFIDENT' : 'LOW CONFIDENCE'
  L.push(`Confidence: **${conf}** (top-package share ${assessment.topShare.toFixed(2)}, ${assessment.hardSignals} identifier(s) named in the ticket)`)
  L.push('')

  if (expansion) {
    L.push(`Intent classified as: ${expansion.intent}${expansion.actionable ? '' : ' — flagged NOT ACTIONABLE'}`)
    if (expansion.reason) L.push(`Reason: ${expansion.reason}`)
    if (termSplit) {
      // The verified/unverified split is worth showing: it tells a reader how much of the
      // model's vocabulary guess actually exists here, which calibrates how much to trust
      // the expansion on this ticket.
      if (termSplit.verified.length) {
        L.push(`Search terms that EXIST in this repo: ${termSplit.verified.join(', ')}`)
      }
      if (termSplit.unverified.length) {
        L.push(`Terms guessed but not found (weak signal only): ${termSplit.unverified.join(', ')}`)
      }
    } else if (expansion.codeTerms?.length) {
      L.push(`Search terms derived: ${expansion.codeTerms.join(', ')}`)
    }
    L.push('')
  }

  if (assessment.packages.length) {
    L.push('### Likely packages')
    for (const p of assessment.packages) L.push(`- ${p.pkg}  (${p.score.toFixed(2)})`)
    L.push('')
  }

  if (reranked) {
    L.push(`### Narrowed picks (${reranked.confidence} confidence)`)
    if (reranked.layerNote) L.push(`_${reranked.layerNote}_`)
    L.push('')
    for (const p of reranked.picks) L.push(`- **[${p.role}]** \`${p.path}\` — ${p.why}`)
    L.push('')
  }

  L.push('### Ranked candidates')
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i]
    const why = r.why.length ? `  _(${r.why.join(', ')})_` : ''
    L.push(`${i + 1}. \`${r.path}\`${why}`)
  }
  L.push('')
  L.push('Signal key: `named` = the ticket quoted this file, symbol or route verbatim ')
  L.push('(highest precision). `history` = files changed for past tickets with similar ')
  L.push('wording. `lexical` = word overlap with path and exported symbols. `graph` = ')
  L.push('imports or is imported by a higher-ranked file — often where the cause sits when ')
  L.push('the symptom is elsewhere.')
  L.push('')
  return L.join('\n')
}
