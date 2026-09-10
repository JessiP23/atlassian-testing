// The /why step, cheaply: what happened to these files before, and what else the tracker knows about
// this symptom. Both are cited (hash, date, key) so a reader can follow any line back in under a
// minute; both are bounded so they cost prompt tokens, not model calls. Null results are reported as
// results — "no related tickets found" is information, not an omission.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { searchIssues } from './jira.mjs'

const exec = promisify(execFile)

/** Recent commits per file: `<7sha> <yyyy-mm-dd> <subject>` lines, newest first. Never throws. */
export async function recentCommits(repo, files, { perFile = 6, maxFiles = 5 } = {}) {
  const out = []
  for (const f of files.slice(0, maxFiles)) {
    try {
      const { stdout } = await exec('git', ['log', '-n', String(perFile), '--date=short', '--format=%h %ad %s', '--', f], { cwd: repo, timeout: 15_000 })
      const lines = stdout.trim().split('\n').filter(Boolean).map((l) => l.slice(0, 140))
      out.push({ file: f, commits: lines })
    } catch { out.push({ file: f, commits: [] }) }
  }
  return out
}

/**
 * Tickets in the same project whose text resembles this one. Jira's text search is the cheapest
 * "has anyone seen this symptom before" there is; a hit that names a different cause is a hypothesis.
 */
export async function relatedTickets({ issueKey, summary, terms = [], project, max = 5 }) {
  const proj = project || String(issueKey).split('-')[0]
  const clean = (t) => String(t || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  const phrases = [clean(summary), ...terms.map(clean)].filter((t) => t.length >= 6).slice(0, 3)
  if (!phrases.length) return { tickets: [], jql: '' }
  const jql = `project = ${proj} AND key != ${issueKey} AND (${phrases.map((p) => `text ~ "${p}"`).join(' OR ')}) ORDER BY updated DESC`
  try {
    const tickets = await searchIssues(jql, { max })
    return { tickets, jql }
  } catch (e) {
    return { tickets: [], jql, error: String(e.message).split('\n')[0].slice(0, 120) }
  }
}

/** Prompt section. Explicit about what was searched and what came back empty. */
export function historyBlock({ commits = [], related = { tickets: [] } }) {
  const lines = ['## History — evidence about WHY the code is the way it is (cite hashes and keys when you use them)']
  for (const c of commits) {
    lines.push(`${c.file}:`)
    lines.push(...(c.commits.length ? c.commits.map((l) => `  ${l}`) : ['  (no history — new file or shallow clone)']))
  }
  if (related.tickets?.length) {
    lines.push('Related tickets (same project, similar text; newest first):')
    lines.push(...related.tickets.map((t) => `  ${t.key} [${t.status}] ${t.summary.slice(0, 110)}`))
    lines.push('A related ticket that describes the same symptom with a DIFFERENT cause is a hypothesis; a fix that')
    lines.push('already shipped for it means this report may be the path that fix did not cover.')
  } else {
    lines.push(`Related tickets: none found${related.error ? ` (search failed: ${related.error})` : ''}.`)
  }
  return lines.join('\n')
}
