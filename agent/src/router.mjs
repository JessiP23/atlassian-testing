// The Router. Given ticket text, rank the files most likely to need changing.
//
// FOUR signals, in descending order of certainty. None of them is an LLM call.
//
//   0. HARD SIGNALS  - file paths, symbol names, GraphQL ops and routes quoted verbatim
//                      in the ticket. A pasted stack trace is not evidence, it is the
//                      answer; it must not have to compete with word statistics. This is
//                      what makes the router handle wildly different ticket shapes
//                      without per-type rules.
//   1. LEXICAL (BM25)- ticket words against path segments and exported symbol names.
//   2. STRUCTURAL    - a file's import-graph neighbours get a share of its score, because
//                      the cause often sits one hop from the symptom.
//   3. HISTORICAL    - files actually changed for past tickets using similar words.
//                      Learned from merged PRs. The only signal that improves on its own.
//
// Every weight below is a knob for the eval harness. Tune with diag.mjs, not intuition.

import path from 'node:path'
import { BM25 } from './lib/bm25.mjs'
import { baseTokenize, makeTokenizer, weighted } from './lib/tokenize.mjs'
import { deriveStopwords } from './lib/stopwords.mjs'
import { extractSignals } from './lib/extract.mjs'

export const DEFAULT_WEIGHTS = {
  pathWeight: 3,
  exportWeight: 2,
  importWeight: 1,
  gqlWeight: 3,
  routeWeight: 3,

  lexical: 1.0,
  structural: 0.35,
  historical: 1.2,
  hard: 4.0,          // hard signals dominate by design - they are near-certain

  hardPathExact: 1.0, // ticket named this exact file
  hardSymbol: 0.55,   // ticket named a symbol this file exports
  hardGql: 0.7,       // ticket named a GraphQL op this file defines
  hardRoute: 0.5,     // ticket quoted a URL this file routes

  graphHops: 1,
  graphTopSeed: 25,
  dfCeiling: 0.12,        // corpus stopword threshold
  ticketDfCeiling: 0.12,  // ticket-side stopword threshold; measured optimum (MRR 0.191)
  // 'count' | 'lift'. MEASURED on 449 held-out tickets: count wins decisively
  // (any-hit@25 50.0% / MRR 0.191) over lift (37.1% / 0.132).
  //
  // This is counter-intuitive and worth recording so nobody "fixes" it again. The
  // hypothesis for lift was that a grab-bag file edited in many PRs correlates with every
  // ticket and should have its popularity divided out. That was wrong: in this codebase
  // file popularity is genuine signal, not bias. A file touched by 30% of tickets is
  // touched that often because it sits on the path of most work, and normalising the base
  // rate away discards real information. Keep 'lift' available so the comparison stays
  // reproducible via `diag.mjs` section D, but do not make it the default.
  historyMode: 'count',
}

/**
 * Does this string look like an application URL route, as opposed to a glob, a filesystem
 * path, or a config key that happened to be assigned to a `path:` property?
 */
export function isUrlRoute(s) {
  if (typeof s !== 'string') return false
  if (s.length < 2 || s.length > 120) return false
  if (!s.startsWith('/')) return false
  // Globs, regex metacharacters, template holes, file extensions - none are routes.
  if (/[*?()[\]{}+^$\\|<>#%]/.test(s)) return false
  if (/\.(json|ya?ml|ts|tsx|js|jsx|png|svg|css|html)$/i.test(s)) return false
  return /^\/[A-Za-z0-9\-_/:.]*$/.test(s)
}

/** Escape regex metacharacters, preserving `:param` segments as wildcards. */
function routeToRegex(route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // After escaping, `:param` survives intact (`:` is not a metachar) - turn it into a hole.
  const pattern = '^' + escaped.replace(/:[^/]+/g, '[^/]+') + '$'
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

function fileDoc(f, w, tok) {
  const segs = tok(f.path.replace(/\.[^.]+$/, '').replace(/\//g, ' '))
  const imports = f.imports.flatMap((i) => tok(path.basename(i)))
  return [
    ...weighted(segs, w.pathWeight),
    ...weighted(f.exports.flatMap(tok), w.exportWeight),
    ...weighted(imports, w.importWeight),
    ...weighted((f.gqlOps || []).flatMap(tok), w.gqlWeight),
    ...weighted((f.routes || []).flatMap(tok), w.routeWeight),
    // Intra-file vocabulary (indexes built before lib/symbols.mjs existed simply have neither,
    // so an old index still scores — it just scores as it did before).
    ...weighted((f.symbols || []).flatMap(tok), w.symbolWeight),
    ...weighted((f.strings || []).flatMap(tok), w.stringWeight),
  ]
}

// Exported so the LangGraph context pack (graph/src/lib/contextpack.mjs) can reuse THIS resolver
// rather than reimplementing module-specifier resolution and drifting from it. The adjacency here
// is deliberately UNDIRECTED (the router wants "near", not "depends on"); the context pack builds
// its own directed importers/imports maps from the same `resolve`.
export function buildGraph(files) {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const suffixIndex = new Map()
  for (const f of files) {
    const noExt = f.path.replace(/\.[^.]+$/, '')
    for (const key of [noExt, noExt.replace(/\/index$/, '')]) {
      if (!suffixIndex.has(key)) suffixIndex.set(key, [])
      suffixIndex.get(key).push(f.path)
    }
  }
  const resolve = (fromPath, spec) => {
    if (spec.startsWith('.')) {
      const abs = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec))
      for (const cand of [abs, abs + '/index']) {
        const hit = suffixIndex.get(cand)
        if (hit) return hit[0]
      }
      return null
    }
    const tail = spec.replace(/^[@~]/, '').split('/').slice(-2).join('/')
    if (!tail) return null
    for (const [key, paths] of suffixIndex) {
      if (key.endsWith('/' + tail) && paths.length === 1) return paths[0]
    }
    return null
  }
  const adj = new Map()
  const link = (a, b) => {
    if (!a || !b || a === b) return
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a).add(b)
    adj.get(b).add(a)
  }
  for (const f of files) for (const spec of f.imports) link(f.path, resolve(f.path, spec))
  return { adj, byPath, suffixIndex, resolve }
}

/** Learn the token->file association from mined history. */
export function buildHistory(samples, tok = baseTokenize) {
  const tokenFile = new Map()   // token -> file -> co-occurrence count
  const fileCount = new Map()   // file  -> how many tickets touched it
  const tokenTotal = new Map()  // token -> total co-occurrences across all files
  for (const s of samples) {
    const toks = new Set(tok(s.text))
    for (const f of s.files) {
      fileCount.set(f, (fileCount.get(f) || 0) + 1)
      for (const t of toks) {
        let m = tokenFile.get(t)
        if (!m) { m = new Map(); tokenFile.set(t, m) }
        m.set(f, (m.get(f) || 0) + 1)
        tokenTotal.set(t, (tokenTotal.get(t) || 0) + 1)
      }
    }
  }
  return { tokenFile, fileCount, tokenTotal, n: samples.length }
}

/**
 * Two scoring modes, because the obvious one is wrong in a specific and instructive way.
 *
 * 'count' - raw co-occurrence with a weak frequency penalty. This lets a grab-bag file
 *   like utils.ts, edited in a large fraction of all PRs, correlate with EVERY ticket and
 *   sit at the top of every hint. It measures "changes often", not "relevant here".
 *
 * 'lift'  - P(file | token) / P(file). A file that appears in 30% of tickets needs to
 *   appear in far more than 30% of tickets containing this token before it scores. Popular
 *   files are divided out by construction, which is exactly the correction needed.
 */
function historyScore(history, queryTokens, mode = 'lift') {
  const out = new Map()
  if (!history) return out
  const N = history.n || 1

  for (const t of new Set(queryTokens)) {
    const m = history.tokenFile.get(t)
    if (!m) continue
    const idf = Math.log(1 + N / (1 + m.size))

    if (mode === 'count') {
      for (const [f, c] of m) {
        const prior = c / (1 + Math.log(1 + (history.fileCount.get(f) || 1)))
        out.set(f, (out.get(f) || 0) + idf * prior)
      }
      continue
    }

    const total = history.tokenTotal?.get(t) || [...m.values()].reduce((a, b) => a + b, 0)
    for (const [f, c] of m) {
      const pFileGivenToken = c / (total || 1)
      const pFile = (history.fileCount.get(f) || 1) / N
      const lift = pFileGivenToken / (pFile || 1)
      if (lift <= 1) continue // no better than chance for this file - contributes nothing
      // sqrt(c) keeps a single lucky co-occurrence from outranking a well-attested one.
      out.set(f, (out.get(f) || 0) + idf * Math.log(lift) * Math.sqrt(c))
    }
  }
  return out
}

function normalize(m) {
  let max = 0
  for (const v of m.values()) if (v > max) max = v
  if (!max) return m
  const out = new Map()
  for (const [k, v] of m) out.set(k, v / max)
  return out
}

export class Router {
  /**
   * @param {{files:any[],packages:any[]}} index
   * @param {ReturnType<typeof buildHistory>|null} history
   * @param {Partial<typeof DEFAULT_WEIGHTS>} weights
   */
  constructor(index, history = null, weights = {}, ticketStop = null) {
    this.w = { ...DEFAULT_WEIGHTS, ...weights }
    this.index = index
    this.history = history

    // Stopwords derived from THIS repo, not a hand-written list.
    const { stop } = deriveStopwords(index.files, baseTokenize, this.w.dfCeiling)
    this.stop = stop
    this.tok = makeTokenizer(stop)

    // A SECOND, ticket-side stopword set, applied only to query text.
    //
    // Real tickets here are templated: "### Steps to Reproduce", "### Actual Result",
    // "Test Env" appear in nearly every one. At ~200 tokens per ticket that boilerplate
    // links every token to every file and drowns the history signal - measured as MRR
    // falling when history was enabled on real text.
    //
    // Filtering the QUERY harder than the documents is safe: BM25 only scores terms the
    // query contains, so removing a worthless term cannot misalign the vocabularies.
    this.ticketStop = ticketStop || new Set()
    this.queryTok = this.ticketStop.size
      ? (text) => this.tok(text).filter((t) => !this.ticketStop.has(t))
      : this.tok

    this.bm = new BM25()
    for (const f of index.files) this.bm.add(f.path, fileDoc(f, this.w, this.tok))
    this.bm.finalize()

    this.graph = buildGraph(index.files)

    // Reverse lookups for hard signals.
    this.exportOwner = new Map()   // symbol -> Set<path>
    this.gqlOwner = new Map()      // op     -> Set<path>
    this.routeOwner = new Map()    // route  -> Set<path>
    const push = (m, k, v) => {
      if (!k) return
      if (!m.has(k)) m.set(k, new Set())
      m.get(k).add(v)
    }
    for (const f of index.files) {
      for (const e of f.exports || []) push(this.exportOwner, e, f.path)
      for (const g of f.gqlOps || []) push(this.gqlOwner, g, f.path)
      // Filter here as well as in the indexer, so an index built by an older version is
      // still safe. `path:` in source matches plenty of things that are not URL routes -
      // OpenSearch field mappings, glob patterns, filesystem paths - and those contain
      // regex metacharacters that would blow up route matching below.
      for (const r of f.routes || []) if (isUrlRoute(r)) push(this.routeOwner, r, f.path)
    }
    // Compile each route once at construction, not once per candidate per ticket. With
    // ~1,700 tickets x hundreds of routes, compiling in the loop was also a real cost.
    this.routeRegex = new Map()
    for (const route of this.routeOwner.keys()) {
      const re = routeToRegex(route)
      if (re) this.routeRegex.set(route, re)
    }

    this.allPaths = index.files.map((f) => f.path)
  }

  /**
   * Split model-invented identifiers into those that actually exist in this codebase and
   * those that do not.
   *
   * Query expansion produces PLAUSIBLE names - `handleImport`, `importService`,
   * `validateTemplateId`. Plausible is not present. A term that exists nowhere contributes
   * nothing to BM25 and silently wastes the expansion, which is exactly why expansion
   * appeared to do nothing to the ranking. A term that DOES exist is a hard signal, as
   * strong as one the reporter quoted, and should be scored that way.
   *
   * The verified/unverified split is also a cheap quality metric for the expansion prompt:
   * if most terms come back unverified, the prompt is inventing rather than recalling.
   */
  verifyTerms(terms = []) {
    const verified = []
    const unverified = []
    for (const t of terms) {
      if (!t || t.length < 3) continue
      if (this.exportOwner.has(t) || this.gqlOwner.has(t)) { verified.push(t); continue }
      // Also count a term that names a file, e.g. "ImportPopup" -> ImportPopup.tsx
      const asFile = this.allPaths.some((p) => {
        const base = p.split('/').pop().replace(/\.[^.]+$/, '')
        return base === t
      })
      if (asFile) verified.push(t)
      else unverified.push(t)
    }
    return { verified, unverified }
  }

  /** Resolve verbatim identifiers from the ticket onto real files. */
  hardScore(text) {
    const sig = extractSignals(text)
    const out = new Map()
    const bump = (p, amt) => { if (p) out.set(p, (out.get(p) || 0) + amt) }

    // A path in the ticket: suffix-match against real files. Unique match = near certainty.
    for (const raw of sig.filePaths) {
      const norm = raw.replace(/^\.\//, '')
      const matches = this.allPaths.filter((p) => p === norm || p.endsWith('/' + norm))
      // Ambiguous basenames (index.ts) get diluted rather than boosting 40 files equally.
      const share = matches.length ? this.w.hardPathExact / Math.sqrt(matches.length) : 0
      for (const m of matches) bump(m, share)
    }

    for (const s of sig.symbols) {
      const owners = this.exportOwner.get(s)
      if (!owners) continue
      const share = this.w.hardSymbol / Math.sqrt(owners.size)
      for (const p of owners) bump(p, share)
    }

    for (const g of sig.gqlOps) {
      const owners = this.gqlOwner.get(g)
      if (!owners) continue
      const share = this.w.hardGql / Math.sqrt(owners.size)
      for (const p of owners) bump(p, share)
    }

    for (const r of sig.urlPaths) {
      for (const [route, owners] of this.routeOwner) {
        // A ticket URL /home/x/collections/y should hit a route declared as :id-style.
        const routeRe = this.routeRegex.get(route)
        if (!routeRe || !routeRe.test(r)) continue
        const share = this.w.hardRoute / Math.sqrt(owners.size)
        for (const p of owners) bump(p, share)
      }
    }

    return { scores: out, signals: sig }
  }

  /**
   * @param {string} ticketText
   * @param {number} k
   * @returns {{path:string, score:number, pkg:string, why:string[]}[]}
   */
  route(ticketText, k = 25) {
    const q = this.queryTok(ticketText)
    const { scores: hardRaw, signals } = this.hardScore(ticketText)
    if (!q.length && !hardRaw.size) return []

    const lex = normalize(this.bm.score(q))
    const hist = normalize(historyScore(this.history, q, this.w.historyMode))
    const hard = normalize(hardRaw)

    // Structural expansion seeds from BOTH lexical hits and hard hits, because a stack
    // trace naming a component should surface the hook it calls.
    const seedPool = new Map()
    for (const [p, s] of lex) seedPool.set(p, s)
    for (const [p, s] of hard) seedPool.set(p, Math.max(seedPool.get(p) || 0, s))
    const seeds = [...seedPool.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.w.graphTopSeed)

    const struct = new Map()
    let frontier = new Map(seeds)
    for (let hop = 0; hop < this.w.graphHops; hop++) {
      const next = new Map()
      for (const [p, s] of frontier) {
        const nbrs = this.graph.adj.get(p)
        if (!nbrs) continue
        const share = s / Math.max(1, Math.sqrt(nbrs.size))
        for (const nb of nbrs) {
          next.set(nb, (next.get(nb) || 0) + share)
          struct.set(nb, (struct.get(nb) || 0) + share)
        }
      }
      frontier = next
    }
    const structN = normalize(struct)

    const all = new Set([...lex.keys(), ...structN.keys(), ...hist.keys(), ...hard.keys()])
    const scored = []
    for (const p of all) {
      const L = lex.get(p) || 0
      const S = structN.get(p) || 0
      const H = hist.get(p) || 0
      const D = hard.get(p) || 0
      const score =
        this.w.lexical * L + this.w.structural * S + this.w.historical * H + this.w.hard * D
      if (score <= 0) continue
      const why = []
      if (D > 0.15) why.push(`named ${D.toFixed(2)}`)
      if (L > 0.15) why.push(`lexical ${L.toFixed(2)}`)
      if (H > 0.15) why.push(`history ${H.toFixed(2)}`)
      if (S > 0.15) why.push(`graph ${S.toFixed(2)}`)
      scored.push({ path: p, score, pkg: this.graph.byPath.get(p)?.pkg ?? '?', why })
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, k)
    top.signals = signals
    return top
  }

  /**
   * Coarse routing plus an admission-control verdict.
   * A ticket whose candidates scatter across many packages, or whose top score is weak,
   * is a refusal candidate - that is cheaper than a confident wrong PR.
   */
  assess(ticketText) {
    const files = this.route(ticketText, 60)
    const agg = new Map()
    for (const f of files) agg.set(f.pkg, (agg.get(f.pkg) || 0) + f.score)
    const packages = [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([pkg, score]) => ({ pkg, score }))

    const total = packages.reduce((a, p) => a + p.score, 0) || 1
    const topShare = packages.length ? packages[0].score / total : 0
    const sig = files.signals || { filePaths: [], symbols: [], gqlOps: [] }
    const named = sig.filePaths.length + sig.gqlOps.length + sig.symbols.length

    return {
      packages: packages.slice(0, 5),
      files: files.slice(0, 25),
      topShare,                       // concentration: 1.0 = all candidates in one package
      hardSignals: named,
      confident: named > 0 || topShare > 0.45,
    }
  }

  /** @deprecated use assess() */
  routePackages(text, k = 5) {
    return this.assess(text).packages.slice(0, k)
  }
}
