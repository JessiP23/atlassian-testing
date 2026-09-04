#!/usr/bin/env node
// Pick tickets worth running. Free — no model calls, no spend.
//
//   node bin/candidates.mjs --project ESI2 --limit 20
//
// Running the agent on a randomly chosen ticket wastes ~$6 whenever the router cannot localize it,
// and the measured recall curve says that is about a quarter of tickets no matter what (25.1% never
// surface a correct file inside the top 200). So screen first: fetch open bugs, run each through
// the deterministic router, and report what it found. Then spend the $6 on the ones with a real
// candidate set — and deliberately include one or two weak ones to confirm the refusal path fires.
//
// `confidence` here is the ROUTER's own assessment (topShare + hard signals), not a model's.

import '../src/lib/boot.mjs'   // loads graph/.env before anything reads process.env
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { jiraConfig } from '../src/lib/jira.mjs'

const exec = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }

const project = String(flag('project', 'ESI2'))
const limit = Number(flag('limit', 20))
// `--status any` drops the filter entirely; otherwise a comma list. Status names are board-specific
// and there is no universal set, so the default is deliberately broad and the script reports what
// actually exists when nothing matches rather than leaving you to guess.
const statuses = String(flag('status', 'any'))
const types = String(flag('type', 'Bug'))
const ROUTER = path.resolve(import.meta.dirname, '../../src/cli.mjs')
const ROOT = path.dirname(path.dirname(ROUTER))

const { url, auth } = jiraConfig()

// JQL SEARCH DOES NOT WORK ON THIS INSTANCE. Recorded in src/lib/jira.mjs and re-confirmed:
//   POST /rest/api/3/search       -> 410 Gone (retired platform-wide)
//   GET/POST /rest/api/3/search/jql -> 400 on teamassetpanda.atlassian.net
//   GET  /rest/api/3/issue/{key}  -> 200   <- the only one that works
// So this screens an EXPLICIT key list rather than discovering one. Get the list from the Jira UI
// (or an Atlassian connector) and paste it in:
//
//   node bin/candidates.mjs --keys ESI2-3367,ESI2-3369,ESI2-3390
//   node bin/candidates.mjs --keys "$(pbpaste)"
const keys = String(flag('keys', '')).split(/[,\s]+/).map((k) => k.trim().toUpperCase()).filter(Boolean)
if (!keys.length) {
  console.error(`
usage: candidates.mjs --keys ESI2-1234,ESI2-1235[,...]

  JQL search is unavailable on this Jira instance (/search is 410, /search/jql is 400), so this
  screens an explicit key list. Copy the keys from a board or filter in the Jira UI.

  Each key is fetched with GET /issue/{key} (which works), redacted, and run through the
  deterministic router. No model calls, no spend.
`)
  process.exit(1)
}

const { fetchIssue } = await import('../src/lib/jira.mjs')
const issues = []
for (const key of keys) {
  const t = await fetchIssue(key).catch(() => null)
  if (!t) { console.error(`  ${key}: not found or unreadable — skipped`); continue }
  issues.push({ key: t.key, fields: { _ticket: t, summary: t.summary, status: { name: t.status }, priority: { name: t.priority }, issuetype: { name: t.issuetype }, _text: `${t.summary}\n${t.description}\n${(t.comments || []).map((c) => c.body).join('\n')}` } })
}
if (!issues.length) { console.error('\n  nothing readable\n'); process.exit(1) }

console.log(`\n  ${issues.length} open ${project} bug(s) — screened through the router (free)\n`)
// TWO axes, not one. ROUTER says whether the agent can FIND the code; SPEC says whether the ticket
// says enough to act on. ESI2-3367 was STRONG on the first and empty on the second — a one-line
// description, no repro, no comments — so it refused at intake for $0.0026. Screening on
// localization alone wastes picks on tickets that were never actionable.
const specGrade = (t) => {
  const body = `${t?.description || ''}\n${(t?.comments || []).map((c) => c.body).join('\n')}`
  const words = body.split(/\s+/).filter(Boolean).length
  const hints = [
    /at [\w$.]+ \(|Error:|Exception|Traceback|\.tsx?:\d+/.test(body) && 'trace',
    /steps? to reproduce|repro|expected|actual/i.test(body) && 'repro',
    (t?.comments || []).length > 0 && `${t.comments.length}c`,
    (t?.attachments || []).length > 0 && `${t.attachments.length}a`,
  ].filter(Boolean)
  return { grade: words < 25 ? 'THIN' : words < 90 ? 'ok' : 'RICH', words, hints }
}

console.log('  KEY          ROUTER   SPEC  WORDS  SIGNALS         TOP CANDIDATE')
console.log('  ' + '-'.repeat(104))

const rows = []
for (const i of issues) {
  const f = i.fields
  const text = String(f._text || f.summary || '').slice(0, 4000)
  let top = '(router error)', conf = '-', n = 0
  try {
    const { stdout } = await exec('node', [ROUTER, 'route', text, '--k', '50', '--json'], { cwd: ROOT, maxBuffer: 1 << 24 })
    const c = JSON.parse(stdout)
    n = c.length
    if (c.length) {
      top = c[0].path.replace(/^packages\//, '')
      // Score gap between #1 and #5 is a cheap proxy for "is this focused or a flat smear".
      const gap = c[0].score / (c[4]?.score || c[c.length - 1].score || 1)
      conf = gap > 1.5 ? 'strong' : gap > 1.15 ? 'ok' : 'flat'
    } else conf = 'none'
  } catch { /* keep the row, mark it */ }
  const sp = specGrade(f._ticket)
  rows.push({ key: i.key, priority: f.priority?.name || '-', conf, spec: sp.grade, words: sp.words, top, n, summary: f.summary })
  console.log(`  ${i.key.padEnd(12)} ${conf.padEnd(8)} ${sp.grade.padEnd(5)} ${String(sp.words).padStart(5)}  ${sp.hints.join(' ').padEnd(14)} ${top.slice(0, 40)}`)
  console.log(`  ${' '.repeat(12)} ${String(f.summary || '').slice(0, 90)}`)
}

const runnable = rows.filter((r) => r.spec !== 'THIN' && (r.conf === 'strong' || r.conf === 'ok'))
const thin = rows.filter((r) => r.spec === 'THIN')
const unlocatable = rows.filter((r) => r.spec !== 'THIN' && (r.conf === 'flat' || r.conf === 'none'))

console.log('')
console.log(`  ROUTER = can the agent find the code   SPEC = does the ticket say enough to act on`)
console.log(`  Both must hold. A ticket that is THIN refuses at intake for ~$0.003 no matter how well it localizes.`)
console.log('')
console.log(`  runnable ${runnable.length}   thin ${thin.length} (will refuse at intake)   unlocatable ${unlocatable.length} (will refuse at locate)`)
console.log('')
if (runnable.length) {
  console.log('  worth spending on:')
  for (const r of runnable.slice(0, 5)) {
    console.log(`    node bin/run.mjs ${r.key} --repo ~/pioneer-agent --base main --target qa --dry-run`)
  }
  console.log('')
}
if (thin.length) {
  console.log(`  thin (${thin.map((r) => r.key).join(', ')}) — these need a human to add a repro before any agent can help.`)
  console.log('  Worth running ONE to confirm the refusal path, which costs about a third of a cent.')
  console.log('')
}
