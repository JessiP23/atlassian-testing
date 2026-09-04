// Model benchmark. Answers "which model should re-rank, and what does it cost me"
// with measurements on YOUR tickets rather than a public leaderboard.
//
// Re-rank is the right task to benchmark on, for two reasons:
//   - it is the only LLM step that measurably helped (expansion was 9.6% term validity,
//     zero lift - see the note atop expand.mjs);
//   - it is bounded and comparable: every model sees the same 25 candidates and the same
//     ticket, so the only variable is the model.
//
// Every model runs against the SAME ticket sample in the SAME order. A/B on different
// samples is noise, and with n=20 the noise is already larger than most differences you
// will care about - treat a <10pp gap as a tie and increase --sample.

import fs from 'node:fs'
import { Router, buildHistory } from './router.mjs'
import { baseTokenize, makeTokenizer } from './lib/tokenize.mjs'
import { deriveStopwords, deriveTicketStopwords } from './lib/stopwords.mjs'
import { rerank } from './rerank.mjs'
import { usage, resetUsage } from './lib/llm.mjs'

const pct = (x) => `${(x * 100).toFixed(1)}%`

/**
 * Model spec: "id" or "id:priceIn:priceOut" (USD per 1M tokens).
 * Prices drive the cost column only and never affect behaviour - omit them freely.
 *
 * Bedrock ids legitimately contain colons (`...-v1:0`), so prices are parsed from the END
 * and only when both trailing segments are numeric. That is also the trap: passing the
 * literal placeholders `id:IN:OUT` silently produced the id "id:IN:OUT" and 20 failed
 * calls. Now it errors loudly instead.
 */
function parseModel(spec) {
  const parts = spec.split(':')
  const last = parts[parts.length - 1]
  const secondLast = parts[parts.length - 2]

  if (parts.length >= 3 && last !== '' && secondLast !== undefined) {
    const lastNum = Number(last)
    const secondNum = Number(secondLast)
    const bothNumeric = !Number.isNaN(lastNum) && !Number.isNaN(secondNum)

    // Placeholder-shaped trailing segments: letters where a price belongs.
    const looksLikePlaceholder = /^[A-Za-z_]+$/.test(last) && /^[A-Za-z_]+$/.test(secondLast)
    if (looksLikePlaceholder) {
      throw new Error(
        `model spec "${spec}" has non-numeric price segments ":${secondLast}:${last}".\n` +
        `  Either give real numbers  -> ${parts.slice(0, -2).join(':')}:5:25\n` +
        `  or omit prices entirely   -> ${parts.slice(0, -2).join(':')}\n` +
        `  Prices are USD per 1M tokens and only affect the cost column.`
      )
    }

    if (bothNumeric) {
      return { id: parts.slice(0, -2).join(':'), priceIn: secondNum, priceOut: lastNum }
    }
  }

  return {
    id: spec,
    priceIn: Number(process.env.LLM_PRICE_IN || 0),
    priceOut: Number(process.env.LLM_PRICE_OUT || 0),
  }
}

export async function bench({ index, samples, sampleSize = 20, models = [], seed = 7, k = 50 }) {
  const known = new Set(index.files.map((f) => f.path))
  const sorted = [...samples].sort((a, b) => a.date.localeCompare(b.date))
  const cut = Math.floor(sorted.length * 0.75)
  const train = sorted.slice(0, cut)

  const { stop } = deriveStopwords(index.files, baseTokenize)
  const tok = makeTokenizer(stop)
  const ticketStop = deriveTicketStopwords(train, tok, 0.12).stop
  const queryTok = (t) => tok(t).filter((x) => !ticketStop.has(x))
  const router = new Router(index, buildHistory(train, queryTok), {}, ticketStop)

  // Deterministic sample, shared by every model.
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const test = sorted
    .slice(cut)
    .filter((t) => t.files.some((f) => known.has(f)))
    .map((t) => ({ t, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, sampleSize)
    .map((x) => x.t)

  // Precompute candidates once - identical input for every model.
  const cases = test.map((smp) => ({
    smp,
    truth: smp.files.filter((f) => known.has(f)),
    candidates: router.route(smp.text, k),
  }))

  // Router-only baseline: is the correct file already in the top 5 without any model?
  let baseTop5 = 0
  for (const c of cases) {
    const top5 = new Set(c.candidates.slice(0, 5).map((r) => r.path))
    if (c.truth.some((t) => top5.has(t))) baseTop5++
  }

  console.log('')
  console.log(`  sample ${cases.length} tickets, top-${k} candidates, identical for every model`)
  console.log(`  router alone, correct file in top 5:  ${pct(baseTop5 / cases.length)}   (the bar to beat)`)
  console.log('')

  // PREFLIGHT. One cheap call per model before committing to N tickets each. A single bad
  // id previously burned an entire run and reported 0% for everything, which reads like a
  // model quality result rather than a typo.
  const { complete } = await import('./lib/llm.mjs')
  const specs = models.map(parseModel)
  const usable = []
  for (const m of specs) {
    process.env.LLM_MODEL = m.id
    resetUsage()
    const probe = await complete({ system: 'Reply with exactly: OK', user: 'Reply with exactly: OK', maxTokens: 64 })
    if (typeof probe === 'string' && probe.trim()) {
      usable.push(m)
    } else {
      console.log(`  SKIP  ${m.id}  - preflight returned nothing (bad id, no access, or starved budget)`)
      console.log(`        re-run with LLM_DEBUG=1, or check: node src/cli.mjs models --check "${m.id}"`)
    }
  }
  if (!usable.length) {
    console.log('\n  no usable models - nothing to benchmark.\n')
    return { baseTop5: baseTop5 / cases.length, rows: [] }
  }
  if (usable.length < specs.length) console.log('')

  const rows = []
  for (const spec of usable) {
    const { id, priceIn, priceOut } = spec
    process.env.LLM_MODEL = id
    resetUsage()

    let hits = 0, ran = 0, failed = 0, latSum = 0
    let confHigh = 0, picksSum = 0

    for (const c of cases) {
      const t0 = Date.now()
      const rr = await rerank(c.smp.text, c.candidates, index)
      latSum += Date.now() - t0
      if (!rr) { failed++; continue }
      ran++
      picksSum += rr.picks.length
      if (rr.confidence === 'high') confHigh++
      const picked = new Set(rr.picks.map((p) => p.path))
      if (c.truth.some((t) => picked.has(t))) hits++
      process.stdout.write(`\r  ${id}: ${ran + failed}/${cases.length} ...`)
    }

    const cost = (usage.inputTokens / 1e6) * priceIn + (usage.outputTokens / 1e6) * priceOut
    rows.push({
      id,
      hitRate: ran ? hits / ran : 0,
      coverage: ran / cases.length,
      failed,
      avgLatencyMs: cases.length ? latSum / cases.length : 0,
      avgPicks: ran ? picksSum / ran : 0,
      highConf: ran ? confHigh / ran : 0,
      inTok: usage.inputTokens,
      outTok: usage.outputTokens,
      cost,
      costPerTicket: cases.length ? cost / cases.length : 0,
      rateLimited: usage.rateLimited,
    })
    process.stdout.write('\r'.padEnd(80) + '\r')
  }

  console.log('  MODEL                                        hit@5   ran    lat     $/ticket   rl')
  console.log('  ' + '-'.repeat(88))
  for (const r of rows) {
    console.log(
      `  ${r.id.slice(0, 42).padEnd(42)}  ${pct(r.hitRate).padStart(6)}  ` +
      `${pct(r.coverage).padStart(5)}  ${(r.avgLatencyMs / 1000).toFixed(1).padStart(5)}s  ` +
      `$${r.costPerTicket.toFixed(5).padStart(8)}  ${String(r.rateLimited).padStart(3)}`
    )
  }
  console.log('')
  console.log('  hit@5    = a file the engineer actually changed is among the model\'s picks')
  console.log('  ran      = share of tickets the model answered at all (failures excluded from hit@5)')
  console.log('  lat      = wall clock per ticket, including retries')
  console.log('  rl       = rate-limit events')
  console.log('')
  console.log('  A model with high hit@5 but low `ran` is NOT better - it answered fewer questions.')
  console.log('  Compare hit@5 x ran, and treat gaps under ~10pp at this sample size as a tie.')
  console.log('')

  return { baseTop5: baseTop5 / cases.length, rows }
}
