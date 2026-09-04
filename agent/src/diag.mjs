// Diagnostics. Answers "what should I change next" with measurements, not intuition.
//
//   node src/diag.mjs                            # slug text
//   node src/diag.mjs --tickets .par/tickets.json # real ticket text
//
// A. Accuracy vs query length - is the eval starved of text, or is the method the ceiling?
// B. History weight sweep - the optimum moves when text length changes.
// C. Ticket-stopword ceiling sweep - how hard should template boilerplate be filtered?
// D. Single-file tickets - the subset you would automate first.

import fs from 'node:fs'
import { loadEnv } from './lib/env.mjs'
loadEnv(process.cwd())

import { Router, buildHistory } from './router.mjs'
import { baseTokenize, makeTokenizer } from './lib/tokenize.mjs'
import { deriveStopwords, deriveTicketStopwords } from './lib/stopwords.mjs'

const argv = process.argv.slice(2)
const flag = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? undefined : argv[i + 1]
}

const index = JSON.parse(fs.readFileSync('.par/index.json', 'utf8'))
let samples = JSON.parse(fs.readFileSync('.par/history.json', 'utf8'))

const ticketsFile = flag('tickets')
if (ticketsFile) {
  const { enrich } = await import('./jira.mjs')
  const tickets = JSON.parse(fs.readFileSync(ticketsFile, 'utf8'))
  const r = enrich(samples, tickets)
  samples = r.samples
  console.log(`\nusing REAL ticket text for ${r.enriched}/${samples.length} tickets`)
} else {
  console.log('\nusing branch-slug text (pass --tickets .par/tickets.json for real text)')
}

const known = new Set(index.files.map((f) => f.path))
const sorted = [...samples].sort((a, b) => a.date.localeCompare(b.date))
const cut = Math.floor(sorted.length * 0.75)
const train = sorted.slice(0, cut)
const test = sorted.slice(cut)

const { stop } = deriveStopwords(index.files, baseTokenize)
const tok = makeTokenizer(stop)
const pct = (x) => `${(x * 100).toFixed(1)}%`

function measure(router, subset) {
  let hit = 0, n = 0, rSum = 0, mrr = 0
  for (const s of subset) {
    const truth = s.files.filter((f) => known.has(f))
    if (!truth.length) continue
    const ranked = router.route(s.text, 25)
    const top = new Set(ranked.map((r) => r.path))
    let h = 0
    for (const t of truth) if (top.has(t)) h++
    if (h > 0) hit++
    rSum += h / truth.length
    const ts = new Set(truth)
    for (let i = 0; i < ranked.length; i++) if (ts.has(ranked[i].path)) { mrr += 1 / (i + 1); break }
    n++
  }
  return { n, anyHit: n ? hit / n : 0, recall25: n ? rSum / n : 0, mrr: n ? mrr / n : 0 }
}

function build(ticketDf, weights = {}) {
  const { stop: ticketStop } = deriveTicketStopwords(train, tok, ticketDf)
  const queryTok = (t) => tok(t).filter((x) => !ticketStop.has(x))
  const history = buildHistory(train, queryTok)
  return { ticketStop, history, router: new Router(index, history, weights, ticketStop) }
}

// ---------- A ----------
console.log('\n=== A. accuracy vs query length ===\n')
{
  const { ticketStop, router } = build(0.25)
  console.log(`  (ticket stopwords derived: ${ticketStop.size})\n`)
  const queryTok = (t) => tok(t).filter((x) => !ticketStop.has(x))
  for (const [lo, hi] of [[0, 5], [6, 20], [21, 60], [61, 150], [151, 99999]]) {
    const subset = test.filter((s) => {
      const n = queryTok(s.text).length
      return n >= lo && n <= hi
    })
    if (subset.length < 5) continue
    const m = measure(router, subset)
    console.log(
      `  ${String(lo).padStart(3)}-${String(hi === 99999 ? '+' : hi).padEnd(4)} tokens  n=${String(m.n).padStart(4)}` +
      `   any-hit@25 ${pct(m.anyHit).padStart(6)}   r@25 ${pct(m.recall25).padStart(6)}   MRR ${m.mrr.toFixed(3)}`
    )
  }
}

// ---------- B ----------
console.log('\n=== B. history weight sweep (ticketDf=0.25) ===\n')
for (const hw of [0, 0.3, 0.6, 1.2, 2.5]) {
  const { router } = build(0.25, { historical: hw })
  const m = measure(router, test)
  console.log(`  historical=${String(hw).padEnd(5)}  any-hit@25 ${pct(m.anyHit).padStart(6)}   r@25 ${pct(m.recall25).padStart(6)}   MRR ${m.mrr.toFixed(3)}`)
}

// ---------- C ----------
console.log('\n=== C. ticket-stopword ceiling sweep ===\n')
for (const df of [1.0, 0.5, 0.25, 0.12, 0.06]) {
  const { ticketStop, router } = build(df)
  const m = measure(router, test)
  console.log(
    `  ticketDf=${String(df).padEnd(5)} stop=${String(ticketStop.size).padStart(5)}` +
    `  any-hit@25 ${pct(m.anyHit).padStart(6)}   r@25 ${pct(m.recall25).padStart(6)}   MRR ${m.mrr.toFixed(3)}`
  )
}
console.log('  (ticketDf=1.0 means no ticket-side filtering at all - the old behaviour)')

// ---------- D ----------
console.log('\n=== D. history scoring mode: raw count vs lift ===\n')
for (const mode of ['count', 'lift']) {
  const { router } = build(0.12, { historyMode: mode })
  const m = measure(router, test)
  console.log(`  ${mode.padEnd(6)}  any-hit@25 ${pct(m.anyHit).padStart(6)}   r@25 ${pct(m.recall25).padStart(6)}   MRR ${m.mrr.toFixed(3)}`)
}
console.log('  count = raw co-occurrence, weak frequency penalty. lift = P(file|token)/P(file).')
console.log('  MEASURED RESULT: count wins. File popularity turned out to be real signal in')
console.log('  this codebase, not bias - normalising it away loses information. Default is')
console.log('  count; lift is kept only so this comparison stays reproducible.')

// ---------- E ----------
console.log('\n=== E. single-file tickets (automate these first) ===\n')
{
  const { router } = build(0.12)
  const single = test.filter((s) => s.files.filter((f) => known.has(f)).length === 1)
  const m = measure(router, single)
  console.log(`  n=${m.n}   any-hit@25 ${pct(m.anyHit)}   MRR ${m.mrr.toFixed(3)}\n`)
}
