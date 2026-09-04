#!/usr/bin/env node
// CLI. Four verbs: index, mine, eval, route.
//
//   par index  --repo <path> [--out .par/index.json]
//   par mine   --repo <path> [--since 2024-01-01] [--ref origin/main] [--out .par/history.json]
//   par eval   [--index .par/index.json] [--history .par/history.json] [--test 0.25]
//   par route  "<ticket text>" [--k 15] [--packages] [--json]

import fs from 'node:fs'
import path from 'node:path'
import { loadEnv } from './lib/env.mjs'

// Load .env / .env.local before anything reads process.env. Real environment wins.
const envFiles = loadEnv(process.cwd())

import { buildIndex } from './indexer.mjs'
import { mine } from './mine.mjs'
import { evaluate } from './eval.mjs'
import { Router, buildHistory } from './router.mjs'
import { fetchTickets, enrich } from './jira.mjs'

const args = process.argv.slice(2)
const cmd = args[0]

function flag(name, dflt = undefined) {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return dflt
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : true
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 0))
  const kb = (fs.statSync(file).size / 1024).toFixed(0)
  console.log(`  wrote ${file}  (${kb} KB)`)
}

function load(file) {
  if (!fs.existsSync(file)) {
    console.error(`missing ${file} - run the earlier step first`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const pct = (x) => `${(x * 100).toFixed(1)}%`

if (cmd === 'index') {
  const repo = path.resolve(String(flag('repo', '.')))
  const out = String(flag('out', '.par/index.json'))
  console.log(`indexing ${repo} ...`)
  const t0 = Date.now()
  const idx = buildIndex(repo)
  console.log(`  ${idx.files.length} source files, ${idx.packages.length} packages, ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  save(out, idx)

} else if (cmd === 'mine') {
  const repo = path.resolve(String(flag('repo', '.')))
  const out = String(flag('out', '.par/history.json'))
  const since = String(flag('since', '2024-01-01'))
  const ref = String(flag('ref', 'origin/main'))
  console.log(`mining ${ref} since ${since} ...`)
  const res = mine({ repoRoot: repo, ref, since })
  console.log(`  ${res.samples.length} usable tickets from ${res.totalMerges} merges`)
  console.log(`  skipped: ${JSON.stringify(res.skipped)}`)
  const sizes = res.samples.map((s) => s.files.length).sort((a, b) => a - b)
  if (sizes.length) {
    const med = sizes[Math.floor(sizes.length / 2)]
    console.log(`  files per ticket: median ${med}, max ${sizes[sizes.length - 1]}`)
  }
  save(out, res.samples)

} else if (cmd === 'doctor') {
  const { probe, jiraConfig } = await import('./jira.mjs')
  console.log(`env files loaded: ${envFiles.length ? envFiles.join(', ') : '(none)'}`)
  const cfg = jiraConfig()
  console.log(`JIRA_URL   ${cfg.url}`)
  console.log(`JIRA_EMAIL ${process.env.JIRA_EMAIL}`)
  console.log(`token      ${'*'.repeat(8)}${(process.env.JIRA_API_TOKEN || '').slice(-4)}`)
  console.log('')
  const p = await probe(cfg)
  for (const n of p.notes) console.log(`  ${n}`)
  console.log('')
  console.log(p.auth ? '  auth: OK' : '  auth: FAILED')
  console.log(p.search ? `  search: ${p.search.path}` : '  search: none - will use per-issue fallback')
  console.log(`  llm provider: ${process.env.LLM_PROVIDER || 'none'}`)
  console.log('')

} else if (cmd === 'fetch') {
  const samples = load(String(flag('history', '.par/history.json')))
  const out = String(flag('out', '.par/tickets.json'))
  console.log(`fetching real ticket text for ${samples.length} keys ...`)
  const tickets = await fetchTickets(samples.map((s) => s.key), out)
  const { enriched } = enrich(samples, tickets)
  const lens = samples
    .map((s) => (tickets[s.key]?.text || '').length)
    .filter((n) => n > 20)
    .sort((a, b) => a - b)
  console.log(`  ${enriched}/${samples.length} tickets have usable text`)
  if (lens.length) {
    console.log(`  text length: median ${lens[Math.floor(lens.length / 2)]} chars, max ${lens[lens.length - 1]}`)
  }
  console.log(`  now run:  node src/cli.mjs eval --tickets ${out}`)

} else if (cmd === 'eval') {
  const index = load(String(flag('index', '.par/index.json')))
  let samples = load(String(flag('history', '.par/history.json')))
  const testFraction = Number(flag('test', '0.25'))

  const ticketsFile = flag('tickets')
  if (ticketsFile) {
    const tickets = load(String(ticketsFile))
    const r = enrich(samples, tickets)
    samples = r.samples
    console.log(`\n  using REAL ticket text for ${r.enriched}/${samples.length} tickets`)
  } else {
    console.log('\n  using branch-slug text (pass --tickets .par/tickets.json for real ticket text)')
  }

  const r = evaluate({ index, samples, testFraction })

  console.log('')
  console.log(`  files indexed      ${r.counts.indexedFiles}   packages ${r.counts.packages}`)
  console.log(`  tickets            ${r.counts.total}  (train ${r.counts.train}, test ${r.counts.test})`)
  console.log(`  train window       ${r.counts.trainRange?.join(' .. ')}`)
  console.log(`  test window        ${r.counts.testRange?.join(' .. ')}`)
  console.log(`  reachable at HEAD  ${pct(r.withHistory.reachableFraction)} of ground-truth files`)
  console.log(`  stopwords derived  ${r.counts.corpusStopwords} corpus, ${r.counts.ticketStopwords} ticket-side`)
  console.log('')
  const row = (label, m) =>
    console.log(
      `  ${label.padEnd(16)} r@1 ${pct(m.recall[1]).padStart(6)}   r@5 ${pct(m.recall[5]).padStart(6)}` +
      `   r@10 ${pct(m.recall[10]).padStart(6)}   r@25 ${pct(m.recall[25]).padStart(6)}` +
      `   MRR ${m.mrr.toFixed(3)}   any-hit@25 ${pct(m.hitRateAt25)}`
    )
  row('lexical only', r.lexicalOnly)
  row('+ history', r.withHistory)
  console.log('')
  console.log('  r@k      = fraction of the files an engineer actually changed that appear in the top k')
  console.log('  any-hit  = fraction of tickets where at least one correct file made the top 25')
  console.log('')

} else if (cmd === 'eval-llm') {
  const { evaluateLLM } = await import('./eval-llm.mjs')
  const index = load(String(flag('index', '.par/index.json')))
  let samples = load(String(flag('history', '.par/history.json')))
  const ticketsFile = flag('tickets')
  if (ticketsFile) {
    const { enrich } = await import('./jira.mjs')
    const r = enrich(samples, load(String(ticketsFile)))
    samples = r.samples
    console.log(`  using REAL ticket text for ${r.enriched}/${samples.length} tickets`)
  }
  if ((process.env.LLM_PROVIDER || 'none') === 'none') {
    console.error('\n  LLM_PROVIDER is not set - nothing to measure.')
    console.error('  e.g.  LLM_PROVIDER=groq GROQ_API_KEY=... LLM_MODEL=llama-3.3-70b-versatile\n')
    process.exit(1)
  }
  await evaluateLLM({
    index,
    samples,
    sampleSize: Number(flag('sample', '60')),
    doRerank: !!flag('rerank'),
  })

} else if (cmd === 'models') {
  // Smoke-test model ids through the REAL code path before spending a bench run on them.
  // Bedrock ids are fussy: some models require a cross-region inference profile (the `us.`
  // prefix) and reject the bare id with "on-demand throughput isn't supported", others are
  // the opposite. Cheaper to find out with one 5-token call than with 20 tickets.
  const { complete, resetUsage, usage } = await import('./lib/llm.mjs')
  const ids = String(flag('check', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!ids.length) {
    console.error('usage: par models --check "id1,id2,id3"')
    console.error('  tries each id, and for a bare id also tries the us.<id> inference profile')
    process.exit(1)
  }
  if ((process.env.LLM_PROVIDER || 'none') === 'none') {
    console.error('  set LLM_PROVIDER (e.g. bedrock) first')
    process.exit(1)
  }
  const candidates = []
  for (const id of ids) {
    candidates.push(id)
    if (!id.startsWith('us.') && !id.startsWith('eu.') && !id.startsWith('apac.')) {
      candidates.push(`us.${id}`)
    }
  }
  console.log('')
  for (const id of candidates) {
    process.env.LLM_MODEL = id
    resetUsage()
    const t0 = Date.now()
    // maxTokens 64 rather than 16: reasoning models get it multiplied up in llm.mjs, but
    // a tight budget on a NON-reasoning model we failed to detect returns empty and looks
    // like a broken id. Cheap insurance either way.
    const out = await complete({
      system: 'Reply with exactly: OK',
      user: 'Reply with exactly: OK',
      maxTokens: 64,
    })
    const ms = Date.now() - t0
    const ok = typeof out === 'string' && out.trim().length > 0
    // Tokens billed but no text = the model reasoned and ran out of room to answer.
    const starved = !ok && usage.outputTokens > 0
    const verdict = ok ? 'WORKS ' : starved ? 'EMPTY ' : 'FAILED'
    console.log(
      `  ${verdict}  ${id.padEnd(46)} ${String(ms).padStart(6)}ms  ` +
      `${usage.inputTokens}in/${usage.outputTokens}out  ${ok ? JSON.stringify(out.trim().slice(0, 20)) : ''}`
    )
    if (starved) {
      console.log('           ^ billed tokens but returned no text: reasoning model, needs a bigger budget')
    }
  }
  console.log('')
  console.log('  FAILED with no detail? re-run with LLM_DEBUG=1 to see the Bedrock error.')
  console.log('')

} else if (cmd === 'bench') {
  const { bench } = await import('./bench.mjs')
  const index = load(String(flag('index', '.par/index.json')))
  let samples = load(String(flag('history', '.par/history.json')))
  const ticketsFile = flag('tickets')
  if (ticketsFile) {
    const { enrich } = await import('./jira.mjs')
    const r = enrich(samples, load(String(ticketsFile)))
    samples = r.samples
    console.log(`  using REAL ticket text for ${r.enriched}/${samples.length} tickets`)
  }
  const modelsArg = flag('models')
  if (!modelsArg || modelsArg === true) {
    console.error('usage: par bench --models "id[:priceIn:priceOut],id2[:in:out]" [--sample 20]')
    console.error('  e.g. --models "us.anthropic.claude-opus-5:5:25,us.deepseek.v3-2:0.28:0.42"')
    process.exit(1)
  }
  if ((process.env.LLM_PROVIDER || 'none') === 'none') {
    console.error('  LLM_PROVIDER is not set. For Bedrock: LLM_PROVIDER=bedrock AWS_REGION=us-east-1')
    process.exit(1)
  }
  try {
    await bench({
      index,
      samples,
      sampleSize: Number(flag('sample', '20')),
      models: String(modelsArg).split(',').map((s) => s.trim()).filter(Boolean),
      k: Number(flag('k', '50')),
    })
  } catch (err) {
    console.error(`\n  ${err.message}\n`)
    process.exit(1)
  }

} else if (cmd === 'hint') {
  const { hint, renderHint } = await import('./hint.mjs')
  const key = args[1] && !args[1].startsWith('--') ? args[1] : ''
  if (!key) { console.error('usage: par hint <ISSUE-KEY> [--llm] [--rerank] [--out file]'); process.exit(1) }
  try {
    const result = await hint({
      key,
      text: flag('text') === true ? undefined : flag('text'),
      useLlm: !!flag('llm'),
      useRerank: !!flag('rerank'),
      k: Number(flag('k', '25')),
    })
    const md = renderHint(result)
    const out = flag('out')
    if (out && out !== true) {
      fs.mkdirSync(path.dirname(String(out)), { recursive: true })
      fs.writeFileSync(String(out), md)
      console.error(`  wrote ${out}  (confidence: ${result.assessment.confident ? 'confident' : 'low'})`)
    } else {
      process.stdout.write(md)
    }
    // Exit code lets a shell gate on confidence without parsing the markdown.
    process.exit(result.assessment.confident ? 0 : 2)
  } catch (err) {
    console.error(`  hint failed: ${err.message}`)
    process.exit(1)
  }

} else if (cmd === 'route') {
  const text = args[1] && !args[1].startsWith('--') ? args[1] : ''
  if (!text) { console.error('usage: par route "<ticket text>"'); process.exit(1) }
  const index = load(String(flag('index', '.par/index.json')))
  const histFile = String(flag('history', '.par/history.json'))
  const history = fs.existsSync(histFile) ? buildHistory(load(histFile)) : null
  const router = new Router(index, history)

  let query = text
  if (flag('llm')) {
    const { expandQuery, buildQuery } = await import('./expand.mjs')
    const exp = await expandQuery(text, index.packages.map((p) => p.name))
    if (exp) {
      console.log(`  intent: ${exp.intent}   actionable: ${exp.actionable}${exp.reason ? `  (${exp.reason})` : ''}`)
      console.log(`  codeTerms: ${exp.codeTerms.join(', ')}`)
      console.log('')
      query = buildQuery(text, exp)
    } else {
      console.log('  (expansion unavailable - falling back to deterministic)\n')
    }
  }

  if (flag('packages')) {
    const a = router.assess(query)
    console.log(`  confident: ${a.confident}   topShare: ${a.topShare.toFixed(2)}   hardSignals: ${a.hardSignals}`)
    for (const p of a.packages) console.log(`  ${p.score.toFixed(3)}  ${p.pkg}`)
  } else {
    const k = Number(flag('k', '25'))
    const ranked = router.route(query, k)

    // --json: machine-readable output for the LangGraph locate node (graph/src/nodes/locate.mjs).
    // Carries the exported symbol names too, because the re-rank prompt needs them to tell an
    // owning file from a file that merely mentions the words.
    if (flag('json')) {
      const byPath = new Map(index.files.map((f) => [f.path, f]))
      console.log(JSON.stringify(ranked.map((r) => ({
        path: r.path,
        score: Number(r.score.toFixed(4)),
        why: r.why,
        exports: byPath.get(r.path)?.exports || [],
      }))))
      process.exit(0)
    }

    for (const r of ranked) {
      console.log(`  ${r.score.toFixed(3)}  ${r.path}`)
      if (r.why.length) console.log(`          ${r.why.join('  ')}`)
    }
    if (flag('rerank')) {
      const { rerank } = await import('./rerank.mjs')
      const rr = await rerank(text, ranked, index)
      if (rr) {
        console.log(`\n  --- rerank (${rr.confidence}) ---`)
        if (rr.layerNote) console.log(`  ${rr.layerNote}`)
        for (const p of rr.picks) console.log(`  [${p.role}] ${p.path}\n          ${p.why}`)
      }
    }
  }

} else {
  console.log(`panda-agent-router

  par index --repo <path>                 build the repo map
  par mine  --repo <path> --since <date>  extract ticket->file ground truth from merged PRs
  par doctor                              check Jira auth + which API endpoints this site serves
  par fetch                               pull real ticket text from Jira (needs JIRA_* env)
  par eval  [--tickets .par/tickets.json] score the router against held-out tickets
  par eval-llm [--sample 60] [--rerank]   measure whether LLM expansion is worth its cost
  par models --check "id1,id2"            smoke-test model ids before benchmarking them
  par bench --models "a:in:out,b:in:out"  compare models on re-rank: hit@5, latency, $/ticket
  par hint <ISSUE-KEY> [--llm] [--rerank] markdown hint block for a coding agent's triage
                       [--out <file>]     exit 0 = confident, 2 = low confidence
  par route "<ticket text>" [--k 15]      rank files for one ticket
                            [--packages]  packages + admission verdict
                            [--llm]       expand the query with a model first
                            [--rerank]    pick the top 3-5 with a model

  Typical first run:
    node src/cli.mjs index --repo ../..
    node src/cli.mjs mine  --repo ../.. --since 2024-06-01
    node src/cli.mjs eval                              # baseline, slug text
    export JIRA_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=...
    node src/cli.mjs fetch
    node src/cli.mjs eval --tickets .par/tickets.json   # the number that decides step 3
`)
}
