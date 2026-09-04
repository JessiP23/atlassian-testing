// LLM-mode eval. Answers one question with a number instead of an opinion:
//
//   Does LLM query expansion improve candidate recall enough to justify its cost?
//
// Runs on a bounded random sample (LLM calls cost money and time), and always reports the
// deterministic baseline on the SAME sample, so the comparison is paired. A/B on
// different samples would be noise.

import fs from 'node:fs'
import { Router, buildHistory } from './router.mjs'
import { baseTokenize, makeTokenizer } from './lib/tokenize.mjs'
import { deriveStopwords } from './lib/stopwords.mjs'
import { expandQuery, buildQuery } from './expand.mjs'
import { rerank } from './rerank.mjs'
import { usage, estimateCost, provider } from './lib/llm.mjs'

const pct = (x) => `${(x * 100).toFixed(1)}%`

function anyHit(ranked, truth, k) {
  const top = new Set(ranked.slice(0, k).map((r) => r.path))
  for (const t of truth) if (top.has(t)) return true
  return false
}
function recall(ranked, truth, k) {
  const top = new Set(ranked.slice(0, k).map((r) => r.path))
  let h = 0
  for (const t of truth) if (top.has(t)) h++
  return truth.length ? h / truth.length : 0
}

export async function evaluateLLM({ index, samples, sampleSize = 60, doRerank = false, seed = 7 }) {
  const known = new Set(index.files.map((f) => f.path))
  const pkgNames = index.packages.map((p) => p.name)

  const sorted = [...samples].sort((a, b) => a.date.localeCompare(b.date))
  const cut = Math.floor(sorted.length * 0.75)
  const train = sorted.slice(0, cut)
  let test = sorted.slice(cut)

  const { stop } = deriveStopwords(index.files, baseTokenize)
  const tok = makeTokenizer(stop)
  const router = new Router(index, buildHistory(train, tok))

  // Deterministic pseudo-random sample so runs are comparable.
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  test = test
    .filter((t) => t.files.some((f) => known.has(f)))
    .map((t) => ({ t, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, sampleSize)
    .map((x) => x.t)

  const stats = {
    n: 0,
    baseHit25: 0, baseR25: 0, baseR5: 0,
    llmHit25: 0, llmR25: 0, llmR5: 0,
    expanded: 0, notActionable: 0,
    rerankHit5: 0, rerankRuns: 0,
    termsVerified: 0, termsTotal: 0,
    intents: {},
  }

  for (const smp of test) {
    const truth = smp.files.filter((f) => known.has(f))
    stats.n++

    const base = router.route(smp.text, 25)
    if (anyHit(base, truth, 25)) stats.baseHit25++
    stats.baseR25 += recall(base, truth, 25)
    stats.baseR5 += recall(base, truth, 5)

    const exp = await expandQuery(smp.text, pkgNames)
    let split = null
    if (exp) {
      stats.expanded++
      stats.intents[exp.intent] = (stats.intents[exp.intent] || 0) + 1
      if (!exp.actionable) stats.notActionable++
      split = router.verifyTerms(exp.codeTerms)
      stats.termsVerified += split.verified.length
      stats.termsTotal += split.verified.length + split.unverified.length
    }
    const llmRanked = router.route(buildQuery(smp.text, exp, split), 25)
    if (anyHit(llmRanked, truth, 25)) stats.llmHit25++
    stats.llmR25 += recall(llmRanked, truth, 25)
    stats.llmR5 += recall(llmRanked, truth, 5)

    if (doRerank) {
      const rr = await rerank(smp.text, llmRanked, index)
      if (rr) {
        stats.rerankRuns++
        const picks = new Set(rr.picks.map((p) => p.path))
        for (const t of truth) if (picks.has(t)) { stats.rerankHit5++; break }
      }
    }

    if (stats.n % 10 === 0) process.stdout.write(`\r  ${stats.n}/${test.length} ...`)
  }

  const n = stats.n || 1
  console.log(`\r  provider ${provider()}   sample ${stats.n}   expanded ${stats.expanded}   llm calls ${usage.calls}   errors ${usage.errors}   rate-limited ${usage.rateLimited}`)
  if (usage.errors > stats.n / 4) {
    console.log('')
    console.log('  WARNING: a large share of calls failed, so the comparison below is NOT valid.')
    console.log('  Re-run with LLM_DEBUG=1 to see why. On a free tier this is usually the rate')
    console.log('  limit - lower --sample, or switch LLM_PROVIDER to bedrock.')
  }
  console.log('')
  console.log(`  deterministic     any-hit@25 ${pct(stats.baseHit25 / n).padStart(6)}   r@25 ${pct(stats.baseR25 / n).padStart(6)}   r@5 ${pct(stats.baseR5 / n).padStart(6)}`)
  console.log(`  + LLM expansion   any-hit@25 ${pct(stats.llmHit25 / n).padStart(6)}   r@25 ${pct(stats.llmR25 / n).padStart(6)}   r@5 ${pct(stats.llmR5 / n).padStart(6)}`)
  if (doRerank && stats.rerankRuns) {
    console.log(`  + rerank to <=5   hit-rate   ${pct(stats.rerankHit5 / stats.rerankRuns).padStart(6)}   (over ${stats.rerankRuns} reranked)`)
  }
  console.log('')
  if (stats.termsTotal) {
    console.log(`  derived terms that exist in the repo: ${stats.termsVerified}/${stats.termsTotal} (${pct(stats.termsVerified / stats.termsTotal)})`)
    console.log('    low = the expansion prompt is inventing names rather than recalling real ones')
  }
  console.log(`  intents: ${JSON.stringify(stats.intents)}`)
  console.log(`  flagged not-actionable: ${stats.notActionable}/${stats.expanded}  (admission-control signal)`)
  console.log(`  tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`)
  console.log(`  est cost this run: $${estimateCost().toFixed(4)}   per ticket: $${(estimateCost() / n).toFixed(4)}`)
  console.log('')

  return stats
}

export function loadJson(f) {
  if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1) }
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}
