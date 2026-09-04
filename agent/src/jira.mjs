// Jira fetcher. Replaces the branch-slug proxy with real ticket text.
//
// Diagnostic A showed accuracy more than doubling from <=3 query tokens to 6+. The mined
// branch slug averages ~4. A real ticket carries 50-400. This is the cheapest available
// accuracy lever and it needs no model.
//
// ENDPOINT DISCOVERY, and why it exists: Atlassian retired `POST /rest/api/2/search` on
// Jira Cloud in favour of `/search/jql`, which uses token pagination instead of
// startAt/maxResults. A retired endpoint answers 404 with "Site temporarily unavailable",
// which reads like an outage and is not one. Rather than pin one API version and break
// whenever Atlassian moves, `probe()` finds what this site actually serves and the
// fetcher adapts - including a per-issue fallback that has never been deprecated.

import fs from 'node:fs'
import path from 'node:path'
import { adfToText } from './lib/adf.mjs'
import { redact } from './lib/redact.mjs'

/** Count of secrets stripped across the run - surfaced so it is visible, not silent. */
export const redactionStats = { total: 0, tickets: 0 }

const BATCH = 50
const CONCURRENCY = 3

export function jiraConfig() {
  const missing = ['JIRA_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((k) => !process.env[k])
  if (missing.length) {
    console.error(`missing env: ${missing.join(', ')}`)
    console.error('  put them in .env (see .env.example)')
    process.exit(1)
  }
  const url = process.env.JIRA_URL.replace(/\/+$/, '').replace(/\/rest.*$/, '')
  const auth =
    'Basic ' +
    Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')
  return { url, auth }
}

async function call({ url, auth }, pathname, { method = 'GET', body } = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 30_000)
  try {
    const res = await fetch(`${url}${pathname}`, {
      method,
      signal: ac.signal,
      headers: {
        authorization: auth,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 400) }
  } catch (err) {
    const code = err?.cause?.code || err?.code || err?.name || 'unknown'
    return { ok: false, status: 0, network: code, text: String(err.message).slice(0, 200) }
  } finally {
    clearTimeout(t)
  }
}

const FIELDS = ['summary', 'description', 'comment', 'issuetype', 'status', 'labels']

/**
 * Find out what this Jira site actually supports.
 * @returns {Promise<{auth:any, search:{kind:string,path:string}|null, notes:string[]}>}
 */
export async function probe(cfg) {
  const notes = []

  // 1. Does auth work at all? Separates "bad token" from "wrong endpoint".
  const me = await call(cfg, '/rest/api/3/myself')
  if (me.network) {
    notes.push(`network unreachable (${me.network}) - VPN, sandbox egress, or wrong JIRA_URL`)
    return { auth: null, search: null, notes }
  }
  if (!me.ok) {
    notes.push(`auth check /rest/api/3/myself -> ${me.status} ${me.text}`)
    if (me.status === 401) notes.push('401 = bad email or API token')
    if (me.status === 403) notes.push('403 = token valid but blocked (check site access / 2FA policy)')
    if (me.status === 404) notes.push('404 here means JIRA_URL is not a Jira Cloud site')
    return { auth: null, search: null, notes }
  }
  notes.push(`auth OK as ${me.json?.displayName || me.json?.emailAddress || 'unknown user'}`)

  // 2. Which search endpoint exists? Newest first.
  const candidates = [
    { kind: 'jql-v3', path: '/rest/api/3/search/jql' },
    { kind: 'jql-v2', path: '/rest/api/2/search/jql' },
    { kind: 'legacy-v3', path: '/rest/api/3/search' },
    { kind: 'legacy-v2', path: '/rest/api/2/search' },
  ]
  for (const c of candidates) {
    const body = c.kind.startsWith('jql')
      ? { jql: 'order by created DESC', maxResults: 1, fields: ['summary'] }
      : { jql: 'order by created DESC', maxResults: 1, startAt: 0, fields: ['summary'] }
    const r = await call(cfg, c.path, { method: 'POST', body })
    if (r.ok) {
      notes.push(`search endpoint: ${c.path}  (${c.kind})`)
      return { auth: me.json, search: c, notes }
    }
    notes.push(`  ${c.path} -> ${r.status}`)
  }

  notes.push('no search endpoint worked - will fall back to one request per issue')
  return { auth: me.json, search: null, notes }
}

/**
 * Flatten one issue into a single tokenizable string. Handles both v2 strings and v3 ADF.
 *
 * Redaction happens HERE - the boundary where ticket text enters the system - so nothing
 * downstream (cache file, LLM prompt, log line) can leak a credential a ticket embedded.
 * These tickets routinely carry live test-account passwords in the description.
 */
function flatten(issue) {
  const f = issue.fields || {}
  const parts = [issue.key, f.summary || '', adfToText(f.description)]
  for (const c of (f.comment?.comments || []).slice(0, 6)) parts.push(adfToText(c.body))

  const joined = parts
    .join('\n')
    .replace(/\{code[^}]*\}[\s\S]*?\{code\}/g, ' ')
    .replace(/!\S+?\|[^!]*!/g, ' ')
    .replace(/\[([^|\]]+)\|[^\]]*\]/g, '$1')

  const { text, redactions } = redact(joined)
  if (redactions) {
    redactionStats.total += redactions
    redactionStats.tickets++
  }

  return text.replace(/\s+/g, ' ').slice(0, 8000).trim()
}

async function searchBatch(cfg, search, keys) {
  const jql = `key in (${keys.join(',')})`
  const body = search.kind.startsWith('jql')
    ? { jql, maxResults: keys.length, fields: FIELDS }
    : { jql, maxResults: keys.length, startAt: 0, fields: FIELDS }
  const r = await call(cfg, search.path, { method: 'POST', body })
  if (r.network) return { error: `network: ${r.network}`, network: true }
  if (!r.ok) return { error: `${r.status} ${r.text}` }
  return { issues: r.json?.issues || [] }
}

/** Per-issue fallback. Slower but this endpoint has never been retired. */
async function fetchOne(cfg, key) {
  const r = await call(cfg, `/rest/api/2/issue/${key}?fields=${FIELDS.join(',')}`)
  if (r.network) return { error: `network: ${r.network}`, network: true }
  if (r.status === 404) return { missing: true }
  if (!r.ok) return { error: `${r.status} ${r.text}` }
  return { issue: r.json }
}

/**
 * @param {string[]} keys
 * @param {string} cacheFile
 */
export async function fetchTickets(keys, cacheFile = '.par/tickets.json') {
  const cfg = jiraConfig()

  const p = await probe(cfg)
  for (const n of p.notes) console.log(`  ${n}`)
  if (!p.auth) {
    console.error('\n  ABORTED - cannot authenticate. Nothing fetched.')
    return {}
  }
  console.log('')

  let cache = {}
  if (fs.existsSync(cacheFile)) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch { cache = {} }
  }
  // A previous failed run may have cached empty placeholders - retry those.
  for (const [k, v] of Object.entries(cache)) if (!v?.text && !v?.missing) delete cache[k]

  const todo = [...new Set(keys)].filter((k) => !cache[k])
  console.log(`  ${Object.keys(cache).length} cached, ${todo.length} to fetch`)

  let done = 0, failed = 0, notFound = 0, netError = null
  const errors = new Set()
  const persist = () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify(cache))
  }
  const store = (issue) => {
    cache[issue.key] = {
      key: issue.key,
      text: flatten(issue),
      type: issue.fields?.issuetype?.name,
      labels: issue.fields?.labels || [],
    }
  }

  if (p.search) {
    const batches = []
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (batches.length && !netError) {
          const b = batches.shift()
          if (!b) break
          const r = await searchBatch(cfg, p.search, b)
          if (r.error) {
            failed += b.length
            errors.add(r.error)
            if (r.network) netError = r.error
          } else {
            const seen = new Set()
            for (const issue of r.issues) { seen.add(issue.key); store(issue) }
            for (const k of b) if (!seen.has(k)) { cache[k] = { key: k, text: '', missing: true }; notFound++ }
          }
          done += b.length
          if (done % 200 < BATCH) { process.stdout.write(`\r  fetched ${done}/${todo.length} ...`); persist() }
        }
      })
    )
  } else {
    // Per-issue fallback.
    const queue = [...todo]
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length && !netError) {
          const k = queue.shift()
          if (!k) break
          const r = await fetchOne(cfg, k)
          if (r.network) { netError = r.error; failed++ }
          else if (r.error) { failed++; errors.add(r.error) }
          else if (r.missing) { cache[k] = { key: k, text: '', missing: true }; notFound++ }
          else store(r.issue)
          done++
          if (done % 100 === 0) { process.stdout.write(`\r  fetched ${done}/${todo.length} ...`); persist() }
        }
      })
    )
  }

  persist()
  console.log(`\r  fetched ${done}/${todo.length}   failed ${failed}   not-found ${notFound}`)
  if (redactionStats.tickets) {
    console.log(
      `  redacted ${redactionStats.total} secret(s) across ${redactionStats.tickets} ticket(s) ` +
      `- credentials embedded in ticket text never reach the cache or an LLM prompt`
    )
  }

  if (netError) {
    console.error(`\n  ABORTED - ${netError}`)
    console.error(`  Progress cached in ${cacheFile} - re-run to resume.`)
  } else if (errors.size) {
    console.error(`\n  ${errors.size} distinct error(s):`)
    for (const e of [...errors].slice(0, 3)) console.error(`    ${e}`)
  }
  return cache
}

/** Merge real ticket text into mined samples, falling back to the slug so the set stays paired. */
export function enrich(samples, tickets) {
  let enriched = 0
  const out = samples.map((s) => {
    const t = tickets[s.key]
    if (t && t.text && t.text.length > 20) {
      enriched++
      return { ...s, text: t.text, slugText: s.text, type: t.type, labels: t.labels }
    }
    return { ...s, slugText: s.text }
  })
  return { samples: out, enriched }
}
