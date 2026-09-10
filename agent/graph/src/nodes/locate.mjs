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
import fs from 'node:fs'
import { promisify } from 'node:util'
import path from 'node:path'
import { converseJson } from '../lib/bedrock.mjs'
import { tierFor, estimateCost } from '../lib/models.mjs'
import { loadProfile } from '../../profiles/index.mjs'

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

// THREE SEED SOURCES, THEN ONE HOP.
//
// The router scores path and export vocabulary. That is the strongest single signal on a monorepo
// and NO signal on a small app: "the Deploy Now button is the wrong colour" shares no token with
// `app/page.tsx`, which is how a five-file repo produced zero candidates. The answer is not to
// dump the repo into the prompt — it is to add the signals a reporter actually gives you and then
// walk the graph:
//
//   1. PHRASE  — words the reporter READ ON SCREEN, matched against the index's uiText channel
//                (JSX text and alt/aria/placeholder/title). Exact, multi-word, high precision.
//   2. ROUTER  — BM25 over the indexed surface + history, as before.
//   3. GRAPH   — one hop from whatever seeds 1 and 2 produced, in both directions. A cause is
//                usually one import away from the file that shows the symptom.
//   4. ENTRY   — only when 1-3 are all empty: the profile's entry points (the app's own routes and
//                layouts). Starting where the user's journey starts is a fact about the repo, not
//                a guess, and one hop from there covers a small app completely.
//
// Everything stays bounded by CANDIDATE_K, so the re-rank cost is unchanged on any repo size.
const MIN_CANDIDATES = Number(process.env.PAG_MIN_CANDIDATES || 8)

function loadIndex() {
  const par = process.env.PAG_PAR_DIR || path.resolve(import.meta.dirname, '../../../.par')
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(par, 'index.json'), 'utf8'))
    return { files: idx.files || [], byPath: new Map((idx.files || []).map((f) => [f.path, f])) }
  } catch { return { files: [], byPath: new Map() } }
}

/**
 * Phrases a person would have read on screen: anything quoted, and runs of two or more
 * Capitalised words. Two words minimum unless quoted — a single common word matches everything.
 */
export function ticketPhrases(text) {
  const out = new Set()
  for (const m of String(text).matchAll(/["'\u201c\u2018`]([^"'\u201d\u2019`]{3,60})["'\u201d\u2019`]/g)) out.add(m[1])
  for (const m of String(text).matchAll(/\b([A-Z][A-Za-z0-9.]+(?:\s+[A-Z][A-Za-z0-9.]+){1,4})\b/g)) out.add(m[1])
  return [...out]
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 3 && (p.includes(' ') || /["']/.test(text)))
    .slice(0, 12)
}

/**
 * Code the reporter named: camelCase / PascalCase identifiers and file names. A stack trace or an
 * engineer's comment ("TypeError … in resolveTriggerRelationColumn", "relationSourceField is
 * undefined") is the strongest locator a ticket can carry — and on ESI2-3194 it was in the ticket
 * while every candidate came from UI labels, so the automation handler never made the list.
 */
export function ticketIdentifiers(text) {
  const t = String(text)
  const out = new Set()
  for (const m of t.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) out.add(m[0])              // camelCase
  for (const m of t.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) out.add(m[0])      // PascalCase
  for (const m of t.matchAll(/\b[\w.-]+\.(?:[cm]?[tj]sx?)\b/g)) out.add(m[0])                // file names
  const noise = /^(TypeError|ReferenceError|JavaScript|TypeScript|GraphQL|AppSync|DynamoDB|OpenSearch|CloudWatch|AssetPanda|LinkedIn|README)$/
  return [...out].filter((w) => w.length >= 8 && !noise.test(w)).slice(0, 40)
}

/**
 * What the located files CALL into the other layer: GraphQL operations and the generated hooks/types
 * around them (getActivityLogs, useGetActivityLogsQuery, ActivityLogEntry). These exist in the repo
 * today — unlike a field the plan wants ADDED — so they are what a code seed can find. Deterministic.
 */
const isUiPath = (p) => /packages\/clients\//.test(p) || /\.(tsx|jsx|css|scss)$/.test(p)

export function crossLayerTerms(repo, files) {
  const out = new Set()
  for (const f of files.slice(0, 6)) {
    let text = ''
    try { text = fs.readFileSync(path.join(repo, f), 'utf8') } catch { continue }
    for (const m of text.matchAll(/\b(?:query|mutation|subscription)\s+([A-Z]\w{5,})/g)) out.add(m[1])
    for (const m of text.matchAll(/\buse([A-Z]\w{5,}?)(?:Query|Mutation|LazyQuery|Subscription)\b/g)) { out.add(m[1][0].toLowerCase() + m[1].slice(1)); out.add(m[1]) }
    for (const m of text.matchAll(/\b(get|list|create|update|delete)([A-Z]\w{4,})\b/g)) out.add(m[1] + m[2])
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]@pioneer\/[^'"]+['"]/g)) for (const id of m[1].split(',')) { const w = id.trim().split(/\s+as\s+/)[0]; if (/^[A-Z]\w{5,}$/.test(w)) out.add(w) }
  }
  return [...out].slice(0, 30)
}

/**
 * Concept stems from prose: "impersonation", "impersonated", "impersonates" → "impersonat". These are the
 * words a plan uses when it asks "how is X recorded in the system?" — and grep answers that question.
 */
export function conceptStems(text, { max = 5 } = {}) {
  const stop = /^(function|component|configuration|information|implementation|application|structure|mechanism|detection|provided|visible|backend|frontend|response|request|customer|separate|retrieved|identifies|original|without|confirm|should|happen|whether|between|through|because|correctly|logic|system|record|records|display|displays|instead|address|location|details|internally|auditing|retaining|question)$/
  const freq = new Map()
  for (const m of String(text || '').toLowerCase().matchAll(/\b[a-z]{8,}\b/g)) {
    const w = m[0]
    if (stop.test(w)) continue
    // one light suffix strip so the forms meet: impersonation/impersonated/impersonates/impersonating → impersonat
    const stem = w.replace(/(ions?|ing|ed|es|s)$/, '')
    if (stem.length < 7) continue
    freq.set(stem, (freq.get(stem) || 0) + 1)
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w)
}

/**
 * Files whose CONTENT mentions the concept — `git grep -il`, deterministic, ~1s on the monorepo. Product
 * files only, ranked by how often they mention it. This is how "how is impersonation recorded?" gets
 * answered by the code instead of by a human.
 */
export async function conceptSeeds(repo, stems, { limit = 12, fixed = false } = {}) {
  if (!stems.length) return []
  const counts = new Map()
  for (const stem of stems) {
    let out = ''
    try { ({ stdout: out } = await exec('git', ['grep', '-c', '-i', '-I', ...(fixed ? ['-F'] : []), '--', stem, ':(glob)**/*.ts', ':(glob)**/*.tsx', ':(glob)**/*.graphql'], { cwd: repo, maxBuffer: 1 << 24, timeout: 20_000 })) } catch (e) { out = e.stdout || '' }
    for (const line of out.split('\n')) {
      const m = /^(.+?):(\d+)$/.exec(line.trim())
      if (!m) continue
      const f = m[1]
      if (/(^|\/)(__tests__|__mocks__|test-samples|node_modules|dist)\/|\.(test|spec|stories|d)\.[cm]?[jt]sx?$|\.generated\.|\/generated\//.test(f)) continue
      const cur = counts.get(f) || { n: 0, stems: new Set() }
      cur.n += Number(m[2]); cur.stems.add(stem); counts.set(f, cur)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].stems.size - a[1].stems.size || b[1].n - a[1].n)
    .slice(0, limit)
    .map(([path, v]) => ({ path, exports: [], score: 0, why: `mentions ${[...v.stems].join(', ')} ×${v.n}` }))
}

/**
 * The words the user SAW, as the code would spell them: 3-word windows of plain words from the error text
 * and the values in the ticket ("74.69.105.162 logged in from Syracuse, NY" → "logged in from"). The
 * ticket's vocabulary and the code's often share nothing else — 3265 said "impersonation" and "Summary of
 * Changes"; the code said `is_saiu` and `buildSummary` — but a string the UI renders is in the code verbatim.
 */
export function symptomWindows(strings, { max = 6 } = {}) {
  const out = new Set()
  for (const str of strings) {
    const words = String(str || '').toLowerCase().replace(/<[^>]+>/g, ' ').split(/[^a-z]+/).filter(Boolean)
    for (let i = 0; i + 3 <= words.length; i++) {
      const w = words.slice(i, i + 3).join(' ')
      if (w.length >= 10 && words.slice(i, i + 3).some((x) => x.length >= 4)) out.add(w)
    }
  }
  return [...out].slice(0, max)
}

/** Files that define or are named by one of those identifiers — exports, symbols, or the file name itself. */
function codeSeeds(files, idents) {
  if (!idents.length) return []
  const hits = []
  for (const f of files) {
    const base = f.path.split('/').pop()
    const defined = new Set([...(f.exports || []), ...(f.symbols || [])])
    const matched = idents.filter((id) => id === base || id === base.replace(/\.[cm]?[tj]sx?$/, '') || defined.has(id))
    if (matched.length) hits.push({ path: f.path, exports: f.exports || [], score: 0, why: `defines ${matched.map((m) => `\`${m}\``).join(', ')}`, matched: matched.length })
  }
  return hits.sort((a, b) => b.matched - a.matched)
}

/** Files whose visible text contains one of those phrases. The strongest seed there is. */
function phraseSeeds(files, phrases) {
  if (!phrases.length) return []
  const needles = phrases.map((p) => p.toLowerCase())
  const hits = []
  for (const f of files) {
    const text = (f.uiText || []).map((t) => t.toLowerCase())
    if (!text.length) continue
    const matched = needles.filter((n) => text.some((t) => t === n || t.includes(n) || (n.length >= 6 && n.includes(t))))
    if (matched.length) hits.push({ path: f.path, exports: f.exports || [], score: 0, why: `renders ${matched.map((m) => `"${m}"`).join(', ')}`, matched: matched.length })
  }
  return hits.sort((a, b) => b.matched - a.matched)
}

/** One hop of the import graph from `seeds`, both directions: what they import, and who imports them. */
function graphHop(index, seeds, limit) {
  const seen = new Set(seeds)
  const out = []
  const resolves = (spec, from) => {
    // The index stores import specifiers, not resolved paths. Match on the tail so a relative or
    // aliased import still lines up with an indexed file.
    const tail = String(spec).replace(/^[./]+/, '').replace(/\.[tj]sx?$/, '')
    if (!tail) return null
    const hit = index.files.find((f) => f.path.replace(/\.[tj]sx?$/, '').endsWith(tail))
    return hit && hit.path !== from ? hit : null
  }
  for (const s of seeds) {
    const f = index.byPath.get(s)
    for (const spec of (f?.imports || [])) {
      const dep = resolves(spec, s)
      if (dep && !seen.has(dep.path)) { seen.add(dep.path); out.push({ path: dep.path, exports: dep.exports || [], score: 0, why: `imported by ${s}` }) }
    }
  }
  for (const f of index.files) {
    if (seen.has(f.path)) continue
    if ((f.imports || []).some((spec) => seeds.some((s) => resolves(spec, f.path)?.path === s))) {
      seen.add(f.path); out.push({ path: f.path, exports: f.exports || [], score: 0, why: `imports one of the seeds` })
    }
  }
  return out.slice(0, limit)
}

const dedupe = (list) => {
  const seen = new Set(); const out = []
  for (const c of list) if (c?.path && !seen.has(c.path)) { seen.add(c.path); out.push(c) }
  return out
}

export function locateNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const tier = tierFor('rerank')
    // The symptom is part of the query. "Regex Validation Error" + "OneSchema field-mapping step"
    // reaches `validation_options.regex` in the template builder; the summary alone reaches the
    // backend importer, which is where six runs of ESI2-3393 went. Error text and screen name are
    // the reporter's most precise words, and until now the retriever never saw them.
    const sym = s.spec.symptom || {}
    const symptomText = [sym.errorText, sym.screen, ...(sym.inputs || [])].filter(Boolean).join(' ')
    // A widening from plan: it named what another layer must provide (identifiers, a query name).
    // Those terms join the query and the code seeds, and the previous picks stay in the result.
    const widen = s.escalation?.from === 'plan' ? s.escalation : null
    // On a widening, the terms that matter are the ones the UI files already call (they exist), plus
    // whatever the plan named (which may not exist yet — that is the point of the change).
    const widenTerms = widen ? [...new Set([...crossLayerTerms(s.repo, (s.located || []).map((l) => l.path)), ...(widen.terms || [])])] : []
    if (widen) onProgress?.(`widening with ${widenTerms.length} term(s) from the UI files: ${widenTerms.slice(0, 6).join(', ')}`)
    const query = [s.spec.summary, ...(s.spec.acceptanceCriteria || []), symptomText, ...widenTerms].join(' ')

    // Deterministic, $0, ~2s. Reads .par/index.json — built once per merge, not per ticket.
    // The router reads `.par/` relative to its cwd. In CI the index is built where PAG_PAR_DIR says
    // (the workspace), while the router lives in the image — name the files explicitly, or the run
    // dies at locate with "missing .par/index.json" (3437 on the first container run).
    const par = process.env.PAG_PAR_DIR || path.join(path.dirname(path.dirname(ROUTER_CLI)), '.par')
    const { stdout } = await exec('node', [ROUTER_CLI, 'route', query, '--k', String(CANDIDATE_K), '--json',
      '--index', path.join(par, 'index.json'), '--history', path.join(par, 'history.json')], {
      cwd: path.dirname(path.dirname(ROUTER_CLI)),
      maxBuffer: 1 << 24,
    })
    const routed = JSON.parse(stdout)
    const index = loadIndex()

    // 1. phrases the reporter read on screen — ahead of the lexical score, because an exact label
    //    match is stronger evidence than a term overlap.
    const ticketText = [s.spec.summary, ...(s.spec.acceptanceCriteria || []), symptomText, s.ticket?.description || '', ...(s.ticket?.comments || []).map((c) => c.body || '')].join(' ')
    let code = codeSeeds(index.files, [...widenTerms, ...ticketIdentifiers(ticketText)])
    // Content search for the literal phrases the reporter saw — every run, not only on a widening.
    const windows = symptomWindows([sym.errorText, ...(sym.inputs || [])])
    if (windows.length) {
      const hits = await conceptSeeds(s.repo, windows, { fixed: true, limit: 6 })
      if (hits.length) {
        onProgress?.(`symptom text seeds: ${hits.slice(0, 4).map((c) => `${c.path.split('/').slice(-2).join('/')} (${c.why})`).join('; ')}`)
        code = [...hits, ...code]
      }
    }
    // On a widening, the plan's questions name CONCEPTS ("how is impersonation recorded?"); grep the repo
    // for them so the next plan reads the implementation instead of asking a human where it is.
    let concepts = []
    if (widen) {
      const stems = conceptStems(`${widen.text} ${s.spec.summary}`)
      concepts = await conceptSeeds(s.repo, stems)
      onProgress?.(concepts.length
        ? `concept seeds (${stems.join(', ')}): ${concepts.slice(0, 5).map((c) => `${c.path.split('/').slice(-2).join('/')} (${c.why})`).join('; ')}`
        : `concept seeds: nothing in the repo mentions ${stems.join(', ') || 'the plan\'s terms'}`)
      code = [...concepts, ...code]
    }
    const phrases = ticketPhrases([s.spec.summary, ...(s.spec.acceptanceCriteria || []), symptomText, s.ticket?.description || ''].join(' '))
    const seeds = [...code, ...phraseSeeds(index.files, phrases)]
    let candidates = dedupe([...seeds, ...routed]).slice(0, CANDIDATE_K)
    if (code.length) onProgress?.(`code seeds: ${code.slice(0, 3).map((x) => `${x.path.split('/').pop()} (${x.why})`).join('; ')}`)

    // 3. one hop from those seeds when the list is thin — a cause is usually one import away.
    if (candidates.length < MIN_CANDIDATES && candidates.length) {
      candidates = dedupe([...candidates, ...graphHop(index, candidates.map((c) => c.path), CANDIDATE_K - candidates.length)])
    }

    // 4. nothing matched at all: start from the app's own entry points and hop from there.
    if (!candidates.length) {
      const entries = (loadProfile(s.repo).entryPoints?.(index.files) || []).slice(0, MIN_CANDIDATES)
      if (entries.length) {
        candidates = dedupe(entries.map((f) => ({ path: f.path, exports: f.exports || [], score: 0, why: 'entry point of this app' })))
        candidates = dedupe([...candidates, ...graphHop(index, candidates.map((c) => c.path), CANDIDATE_K - candidates.length)])
      }
    }

    if (!candidates.length) {
      return {
        candidates: [],
        refusal: {
          at: 'locate', reason: 'no_candidates',
          detail: index.files.length
            ? `nothing in the ${index.files.length}-file index matched this ticket by phrase, term or import graph, and the ${loadProfile(s.repo).name} profile declares no entry points.`
            : `the index at ${process.env.PAG_PAR_DIR || '.par'} is empty — rebuild it (bin/ci.mjs per run, bin/refresh.mjs per merge).`,
        },
      }
    }
    if (seeds.length) onProgress?.(`phrase seeds: ${seeds.slice(0, 3).map((x) => x.path).join(', ')}`)

    const user = [
      `TICKET: ${s.spec.summary}`,
      `ACCEPTANCE: ${(s.spec.acceptanceCriteria || []).join(' | ')}`,
      sym.screen ? `SYMPTOM APPEARS ON: ${sym.screen}${sym.errorText ? ` — "${sym.errorText}"` : ''}` : '',
      sym.layer && sym.layer !== 'unknown' ? `LIKELY LAYER: ${sym.layer}${sym.why ? ` (${sym.why})` : ''} — a pick in a different layer must explain how it reaches that screen.` : '',
      widen ? `WIDEN ACROSS LAYERS: the plan for the UI files (${(s.located || []).map((l) => l.path).join(', ')}) stopped because another layer must change first: "${String(widen.text).slice(0, 400)}". Those UI files call ${widenTerms.slice(0, 8).join(', ') || 'operations named above'}.${concepts.length ? ` The candidates marked "mentions …" are where the repo already implements the concept the plan asked about — the plan's questions ("how is it recorded", "is there a field") are answered by reading those; prefer them.` : ''} Pick the files in THIS repo that define or resolve those — the GraphQL schema/type, the resolver or lambda, the data access — so the change can be planned end to end. Up to 5 picks; the UI files are kept automatically. Do not pick UI files again.` : '',
      '',
      'CANDIDATES (rank. path — exports):',
      ...candidates.map((c, i) => `${i + 1}. ${c.path} — ${(c.exports || []).slice(0, 12).join(', ') || '(none)'}`),
    ].join('\n')

    const { data, inTok, outTok } = await converseJson({
      model: tier.model, system: SYSTEM, user, maxTokens: tier.maxTokens,
    })
    budget.charge('rerank', estimateCost(tier, inTok, outTok), { model: tier.model, inTok, outTok })

    const picks = (data.picks || []).filter((p) => candidates.some((c) => c.path === p.path))
    if (widen) {
      // Low confidence here is information for the planner, not a reason to stop: the UI picks are
      // still right, and the code seeds that matched the operations (the schema, a resolver) ride
      // along even when the re-rank would not commit to them.
      const seeded = code.filter((c) => !isUiPath(c.path) && !picks.some((p) => p.path === c.path)).slice(0, 3)
        .map((c) => ({ path: c.path, reason: /^mentions/.test(c.why) ? c.why : `defines ${c.why}` }))
      const prev = (s.located || []).filter((l) => !picks.some((p) => p.path === l.path))
      const other = [...picks.filter((p) => !isUiPath(p.path)), ...seeded]
      onProgress?.(other.length
        ? `widened: +${other.length} file(s) in the other layer — ${other.map((p) => p.path.split('/').slice(-2).join('/')).join(', ')}`
        : 'widened: nothing found in the other layer — the plan decides with what it has')
      return { candidates, located: [...other, ...prev], confidence: data.confidence === 'low' ? 'medium' : data.confidence }
    }
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
