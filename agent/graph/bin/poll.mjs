#!/usr/bin/env node
// Trigger without Jira admin. A Jira Automation rule (Cody's way) needs project-admin rights to
// create; this needs only the read/write the agent's Jira token already has. Every N minutes:
//
//   tickets with label <LABEL>  ->  swap the label to <LABEL>-queued  ->  dispatch the workflow
//
// The swap is the claim: a ticket is dispatched once, and a developer re-adds the label to rerun.
// If the swap is refused (no edit permission) the ticket is still dispatched, with a warning — the
// Actions `concurrency` group then stops a second run from overlapping the first.
//
//   node bin/poll.mjs                 # dispatch what is labelled
//   node bin/poll.mjs --dry-run       # list, touch nothing
//
// Env: PAG_TRIGGER_LABEL (default PandaAgentGraph), PAG_TRIGGER_JQL (default: project ESI2, label,
// not Done), GH_TOKEN + GITHUB_REPOSITORY + PAG_WORKFLOW (default pioneer-ticket-to-pr.yml).
import '../src/lib/boot.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { searchIssues, swapLabel } from '../src/lib/jira.mjs'

const exec = promisify(execFile)
const dry = process.argv.includes('--dry-run')
const LABEL = process.env.PAG_TRIGGER_LABEL || 'PandaAgentGraph'
const QUEUED = `${LABEL}-queued`
const JQL = process.env.PAG_TRIGGER_JQL || `project = ESI2 AND labels = "${LABEL}" AND statusCategory != Done ORDER BY updated ASC`
const REPO = process.env.GITHUB_REPOSITORY
const WORKFLOW = process.env.PAG_WORKFLOW || 'pioneer-ticket-to-pr.yml'

const issues = await searchIssues(JQL, { max: 20 })
console.log(`${issues.length} ticket(s) labelled ${LABEL}${dry ? ' (dry run)' : ''}`)
let dispatched = 0
for (const t of issues) {
  console.log(`  ${t.key}  ${t.status.padEnd(16)} ${t.summary.slice(0, 70)}`)
  if (dry) continue
  try { await swapLabel(t.key, LABEL, QUEUED) } catch (e) { console.log(`    ⚠ could not swap the label (${String(e.message).slice(0, 80)}) — dispatching anyway`) }
  if (!REPO) { console.log('    GITHUB_REPOSITORY not set — nothing dispatched'); continue }
  try {
    await exec('gh', ['workflow', 'run', WORKFLOW, '--repo', REPO, '-f', `issue_key=${t.key}`, '-f', 'dry_run=false'])
    dispatched++
    console.log(`    → dispatched ${WORKFLOW}`)
  } catch (e) { console.log(`    ✗ dispatch failed: ${String(e.message).split('\n')[0].slice(0, 120)}`) }
}
console.log(`${dispatched} run(s) dispatched`)
