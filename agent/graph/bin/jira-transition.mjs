#!/usr/bin/env node
// Move a ticket, comment on it, or just ask what moves it can make.
//
//   node bin/jira-transition.mjs KAN-11                        # what can it do from here?
//   node bin/jira-transition.mjs KAN-11 --to "Done,Closed"     # move it, first match wins
//   node bin/jira-transition.mjs KAN-11 --to Done --comment "Merged: <url>"
//
// Used by .github/workflows/agent-pr-merged.yml, and by hand when a board is named unusually and
// you need the real column names before setting PAG_JIRA_TRANSITION.
//
// EXITS 0 EVEN WHEN IT DOES NOT MOVE THE TICKET. A ticket a human already dragged to Done has
// nothing to do here, and failing the job over it would turn every such merge into a red build.

import '../src/lib/boot.mjs'
import { transition, listTransitions, currentStatus, addComment } from '../src/lib/jira.mjs'

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1] }
const issue = argv.find((a) => /^[A-Z][A-Z0-9]+-\d+$/.test(a))
if (!issue) { console.error('usage: jira-transition.mjs <ISSUE-KEY> [--to "Name,Other"] [--comment "text"]'); process.exit(1) }

const status = await currentStatus(issue).catch((e) => { console.error(`could not read ${issue}: ${e.message}`); return null })
console.log(`${issue} is in: ${status || '(unknown)'}`)

const comment = flag('comment')
if (comment) {
  await addComment(issue, comment)
    .then(() => console.log('  commented'))
    .catch((e) => console.error(`  comment failed: ${e.message}`))
}

const to = flag('to')
if (!to) {
  const ts = await listTransitions(issue).catch(() => [])
  if (!ts.length) console.log('  no transitions available from here')
  for (const t of ts) console.log(`  "${t.name}"  ->  ${t.to}`)
  process.exit(0)
}

const r = await transition(issue, to.split(',').map((x) => x.trim()))
  .catch((e) => ({ moved: false, reason: e.message, available: [] }))
if (r.moved) console.log(`  moved to "${r.to}" (via "${r.via}", matched "${r.matched}")`)
else {
  console.log(`  not moved — ${r.reason}`)
  console.log(`  available: ${(r.available || []).join(' | ') || 'none'}`)
}
process.exit(0)
