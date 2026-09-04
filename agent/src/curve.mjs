#!/usr/bin/env node
// Recall curve. THE diagnostic that decides how wide the candidate set should be.
//
//   node src/curve.mjs
//
// Prints, for the held-out tickets, the rank at which the first correct file appears. Read it two
// ways: the marginal column tells you where widening k stops paying, and the "never retrieved"
// figure is the hard ceiling on the whole pipeline — the fraction of tickets that no amount of
// re-ranking or model spend can rescue, and therefore the fraction that must end in a refusal.
//
// Re-run this after ANY change to retrieval. It is free and it is the only honest way to tell an
// improvement from a hypothesis. Two hypotheses have already died here (query expansion, and
// intra-file vocabulary indexing) — both looked obviously right.
import fs from 'node:fs'
import { Router, buildHistory } from './router.mjs'
import { baseTokenize, makeTokenizer } from './lib/tokenize.mjs'
import { deriveStopwords, deriveTicketStopwords } from './lib/stopwords.mjs'
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const index = load('.par/index.json'), hist = load('.par/history.json'), tickets = load('.par/tickets.json')
const text = new Map(Object.entries(tickets).map(([k, v]) => [k, typeof v === 'string' ? v : v?.text || '']))
const samples = hist.map((h) => ({ ...h, text: text.get(h.key) || h.text }))
const known = new Set(index.files.map((f) => f.path))
const sorted = [...samples].sort((a, b) => a.date.localeCompare(b.date))
const cut = Math.floor(sorted.length * 0.75), train = sorted.slice(0, cut)
const { stop } = deriveStopwords(index.files, baseTokenize)
const tok = makeTokenizer(stop)
const tStop = deriveTicketStopwords(train, tok, 0.12).stop
const R = new Router(index, buildHistory(train, (t) => tok(t).filter((x) => !tStop.has(x))), {}, tStop)
const test = sorted.slice(cut).filter((t) => t.files.some((f) => known.has(f)))

// Rank of the FIRST correct file, per ticket. Everything else is derived from this one pass.
const ranks = test.map((t) => {
  const truth = new Set(t.files.filter((f) => known.has(f)))
  const ranked = R.route(t.text, 200).map((x) => x.path)
  return { i: ranked.findIndex((p) => truth.has(p)), n: truth.size }
})
const pct = (f) => `${(100 * f).toFixed(1)}%`
console.log(`\n  RECALL CURVE — first correct file's rank, ${test.length} held-out tickets\n`)
console.log('   k     any-hit@k   marginal   what a re-rank at this k could reach')
let prev = 0
for (const k of [1, 5, 10, 25, 50, 75, 100, 150, 200]) {
  const hit = ranks.filter((r) => r.i >= 0 && r.i < k).length / ranks.length
  const bar = '█'.repeat(Math.round(hit * 48))
  console.log(`  ${String(k).padStart(4)}    ${pct(hit).padStart(6)}    ${(hit - prev >= 0 ? '+' : '') + pct(hit - prev).padStart(6)}   ${bar}`)
  prev = hit
}
const never = ranks.filter((r) => r.i < 0).length
console.log(`\n  never retrieved at all (rank > 200): ${never} tickets (${pct(never / ranks.length)})`)
console.log('  -> that fraction is the hard ceiling on the whole pipeline. No re-rank can recover it.\n')
// Single-file tickets specifically — the hard case identified above.
const one = ranks.filter((r) => r.n === 1)
console.log(`  single-file tickets (n=${one.length}):`)
for (const k of [5, 25, 50, 100, 200]) {
  console.log(`    any-hit@${String(k).padEnd(4)} ${pct(one.filter((r) => r.i >= 0 && r.i < k).length / one.length)}`)
}
console.log('')
