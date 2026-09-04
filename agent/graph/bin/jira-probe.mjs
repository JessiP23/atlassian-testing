#!/usr/bin/env node
// Why can't the agent read this ticket?  node bin/jira-probe.mjs ESI2-3367 ESI2-3376
import '../src/lib/boot.mjs'
import { probeIssue, jiraConfig } from '../src/lib/jira.mjs'
const keys = process.argv.slice(2)
if (!keys.length) { console.error('usage: jira-probe.mjs <KEY> [KEY...]'); process.exit(1) }
const { url, email, dirty } = jiraConfig()
const { shadowed } = await import('../src/lib/boot.mjs')
const tok = process.env.JIRA_API_TOKEN || ''
console.log(`\n  site   ${url}`)
console.log(`  email  ${email}`)
console.log(`  token  len=${tok.length} first=${JSON.stringify(tok[0])} last=${JSON.stringify(tok[tok.length - 1])} sha=${(await import('node:crypto')).createHash('sha1').update(tok).digest('hex').slice(0, 10)}`)
console.log(`  source ${process.env.GITHUB_ACTIONS ? 'Actions secrets' : (shadowed.includes('JIRA_API_TOKEN') ? '\x1b[33mYOUR SHELL (graph/.env is being ignored)\x1b[0m' : 'graph/.env')}`)
if (dirty.length) console.log(`  \x1b[33m!\x1b[0m quotes/whitespace stripped from: ${dirty.join(', ')}`)
if (tok[0] === '"' || tok[0] === "'") console.log(`  \x1b[31m!\x1b[0m the token still has quote characters in it`)
console.log('')
let bad = 0
for (const k of keys) {
  const p = await probeIssue(k).catch((e) => ({ me: '-', issue: '-', verdict: e.message }))
  const okRead = p.issue === 200
  if (!okRead) bad++
  console.log(`  ${okRead ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${k.padEnd(12)} myself=${String(p.me).padEnd(4)} issue=${String(p.issue).padEnd(4)} ${p.kind || ''}`)
  if (!okRead) console.log(String(p.verdict).split('\n').map((l) => `      ${l}`).join('\n'))
}
console.log('')
// Non-zero so CI stops here instead of paying a model to discover the same thing.
process.exit(bad ? 2 : 0)
