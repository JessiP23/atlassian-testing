#!/usr/bin/env node
// Why can't the agent read this ticket?  node bin/jira-probe.mjs ESI2-3367 ESI2-3376
import '../src/lib/boot.mjs'
import { probeIssue, jiraConfig } from '../src/lib/jira.mjs'
const keys = process.argv.slice(2)
if (!keys.length) { console.error('usage: jira-probe.mjs <KEY> [KEY...]'); process.exit(1) }
const { url } = jiraConfig()
const { shadowed } = await import('../src/lib/boot.mjs')
const tok = process.env.JIRA_API_TOKEN || ''
console.log(`\n  site   ${url}`)
console.log(`  email  ${process.env.JIRA_EMAIL}`)
console.log(`  token  len=${tok.length} first=${JSON.stringify(tok[0])} last=${JSON.stringify(tok[tok.length - 1])} sha=${(await import('node:crypto')).createHash('sha1').update(tok).digest('hex').slice(0, 10)}`)
console.log(`  source ${shadowed.includes('JIRA_API_TOKEN') ? '\x1b[33mYOUR SHELL (graph/.env is being ignored)\x1b[0m' : 'graph/.env'}`)
if (tok[0] === '"' || tok[0] === "'") console.log(`  \x1b[31m!\x1b[0m the token still has quote characters in it`)
console.log('')
for (const k of keys) {
  const p = await probeIssue(k).catch((e) => ({ me: '-', issue: '-', verdict: e.message }))
  console.log(`  ${k.padEnd(12)} myself=${String(p.me).padEnd(4)} issue=${String(p.issue).padEnd(4)} ${p.verdict}`)
}
console.log('')
