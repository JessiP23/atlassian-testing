// The Eval. The only thing here that decides whether any of this is worth building.
//
// Question: given a ticket's text, does the router put the files an engineer actually
// changed near the top of its list?
//
// Two methodological rules this enforces, both easy to get wrong and both fatal:
//
//   1. TIME SPLIT. The history signal is trained on tickets strictly BEFORE the test
//      window. Training on the same tickets you score against reports ~perfect recall
//      and means nothing.
//   2. REACHABILITY. The index is built at HEAD, but an old ticket may have changed files
//      that have since been renamed or deleted - unreachable by construction. We report
//      recall against reachable ground truth AND the reachable fraction, so a low number
//      can be read correctly instead of being blamed on the router.

import { Router, buildHistory } from './router.mjs'
import { baseTokenize, makeTokenizer } from './lib/tokenize.mjs'
import { deriveStopwords, deriveTicketStopwords } from './lib/stopwords.mjs'

function recallAtK(ranked, truth, k) {
  const top = new Set(ranked.slice(0, k).map((r) => r.path))
  let hit = 0
  for (const t of truth) if (top.has(t)) hit++
  return truth.length ? hit / truth.length : null
}

function reciprocalRank(ranked, truth) {
  const t = new Set(truth)
  for (let i = 0; i < ranked.length; i++) if (t.has(ranked[i].path)) return 1 / (i + 1)
  return 0
}

/**
 * @param {object} o
 * @param {{files:any[],packages:any[]}} o.index
 * @param {{key:string,date:string,text:string,files:string[]}[]} o.samples
 * @param {number} [o.testFraction]  newest fraction held out for testing
 * @param {number[]} [o.ks]
 * @param {object} [o.weights]
 */
export function evaluate({ index, samples, testFraction = 0.25, ks = [1, 5, 10, 25], weights = {} }) {
  const known = new Set(index.files.map((f) => f.path))

  const sorted = [...samples].sort((a, b) => a.date.localeCompare(b.date))
  const cut = Math.floor(sorted.length * (1 - testFraction))
  const train = sorted.slice(0, cut)
  const test = sorted.slice(cut)

  // History must be keyed with the SAME tokenizer the router queries with, or lookups
  // silently miss. Derive both stopword sets once and share them.
  const { stop } = deriveStopwords(index.files, baseTokenize, weights.dfCeiling ?? 0.12)
  const tok = makeTokenizer(stop)

  // Ticket-side stopwords come from the TRAIN split only - deriving them from the full
  // set would leak test-window vocabulary into the model.
  // Must match DEFAULT_WEIGHTS.ticketDfCeiling in router.mjs, or eval reports a different
  // configuration than `hint` actually runs - which is how you end up trusting a number
  // that does not describe production.
  const { stop: ticketStop } = deriveTicketStopwords(train, tok, weights.ticketDfCeiling ?? 0.12)
  const queryTok = (t) => tok(t).filter((x) => !ticketStop.has(x))

  const history = buildHistory(train, queryTok)
  const withHistory = new Router(index, history, weights, ticketStop)
  const withoutHistory = new Router(index, null, weights, ticketStop)

  const run = (router) => {
    const acc = Object.fromEntries(ks.map((k) => [k, []]))
    let mrr = 0
    let scoredCount = 0
    let reachableNum = 0
    let reachableDen = 0
    let anyHitAt25 = 0

    for (const s of test) {
      reachableDen += s.files.length
      const truth = s.files.filter((f) => known.has(f))
      reachableNum += truth.length
      if (!truth.length) continue // unreachable at HEAD - not the router's fault

      const ranked = router.route(s.text, Math.max(...ks))
      for (const k of ks) {
        const r = recallAtK(ranked, truth, k)
        if (r !== null) acc[k].push(r)
      }
      mrr += reciprocalRank(ranked, truth)
      if (recallAtK(ranked, truth, 25) > 0) anyHitAt25++
      scoredCount++
    }

    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
    return {
      scored: scoredCount,
      recall: Object.fromEntries(ks.map((k) => [k, mean(acc[k])])),
      mrr: scoredCount ? mrr / scoredCount : 0,
      hitRateAt25: scoredCount ? anyHitAt25 / scoredCount : 0,
      reachableFraction: reachableDen ? reachableNum / reachableDen : 0,
    }
  }

  return {
    counts: {
      total: sorted.length,
      train: train.length,
      test: test.length,
      ticketStopwords: ticketStop.size,
      corpusStopwords: stop.size,
      trainRange: train.length ? [train[0].date, train[train.length - 1].date] : null,
      testRange: test.length ? [test[0].date, test[test.length - 1].date] : null,
      indexedFiles: index.files.length,
      packages: index.packages.length,
    },
    lexicalOnly: run(withoutHistory),
    withHistory: run(withHistory),
  }
}
