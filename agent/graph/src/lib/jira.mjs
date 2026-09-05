// Jira I/O. Thin, direct REST — deliberately NOT an MCP server.
//
// On run ESI2-3376 the `atlassian` MCP server failed to connect (no `docker` in PATH) and the model
// worked around it by calling the REST API itself with the credentials it found in `.env`. It got
// the ticket, but nothing could post a comment, and a workaround improvised by a model is not a
// dependency you want. Endpoint facts worth keeping (each cost a debugging cycle):
//
//   * the site is  teamassetpanda.atlassian.net  (not assetpanda.atlassian.net)
//   * POST /rest/api/3/search      -> 410 Gone      (retired)
//   * POST /rest/api/3/search/jql  -> 400           on this instance
//   * GET  /rest/api/3/issue/{key} -> 200           <- the one that works
//
// Redaction is not optional: 87% of tickets in this corpus (1,567 of 1,796) embed credentials —
// 5,947 secrets total. Anything leaving Jira for a model goes through redact() first.

import { redact } from '../../../src/lib/redact.mjs'
import { adfToText } from '../../../src/lib/adf.mjs'

/**
 * Secrets arrive pasted, and pasted values carry passengers: surrounding quotes, a trailing
 * newline from the clipboard, a non-breaking space from a wiki page, a zero-width character from
 * a chat client. Any one of them changes the Basic header and Jira answers 401 — which then reads
 * as "wrong token" when the token itself is fine. So sanitise, and say so when it happened.
 */
const clean = (v) => String(v ?? '')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')     // zero-width
  .replace(/\u00A0/g, ' ')                    // non-breaking space
  .trim()
  .replace(/^["'`]|["'`]$/g, '')               // wrapping quotes
  .trim()

export function jiraConfig() {
  const rawUrl = process.env.JIRA_URL || process.env.JIRA_BASE_URL || ''
  const rawEmail = process.env.JIRA_EMAIL || process.env.PCA_JIRA_EMAIL || ''
  const rawToken = process.env.JIRA_API_TOKEN || process.env.PCA_JIRA_API_TOKEN || ''
  const url = clean(rawUrl).replace(/\/+$/, '')
  const email = clean(rawEmail)
  const token = clean(rawToken)
  if (!url || !email || !token) {
    throw new Error('JIRA_URL (or JIRA_BASE_URL), JIRA_EMAIL and JIRA_API_TOKEN are required')
  }
  const dirty = [
    rawUrl !== url && 'JIRA_URL', rawEmail !== email && 'JIRA_EMAIL', rawToken.trim() !== token && 'JIRA_API_TOKEN',
  ].filter(Boolean)
  return {
    url, email, dirty,
    host: (() => { try { return new URL(url).host } catch { return url } })(),
    auth: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
  }
}

/**
 * TWO BASE URLS, and which one works depends on the kind of token.
 *
 * A classic API token authenticates against the site itself (https://<site>.atlassian.net/rest/...).
 * A SCOPED token does not: the site URL answers it with a bare 401 and it only works through
 * https://api.atlassian.com/ex/jira/<cloudId>/rest/... . The cloud id is public at
 * {site}/_edge/tenant_info, so it can be resolved at runtime instead of being configured.
 *
 * This is why the first CI run reported "token rejected" for a token that works everywhere else —
 * it is scoped, and only the gateway would have accepted it. (This repo's comment_jira.py already
 * knew; the Node side did not.) The winning base is cached for the process.
 */
let RESOLVED_BASE = null

async function cloudId(url) {
  try {
    const r = await fetch(`${url}/_edge/tenant_info`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    return (await r.json())?.cloudId || null
  } catch { return null }
}

async function bases() {
  const { url } = jiraConfig()
  if (RESOLVED_BASE) return [RESOLVED_BASE]
  const list = [url]
  const id = await cloudId(url)
  if (id) list.push(`https://api.atlassian.com/ex/jira/${id}`)
  return list
}

async function api(pathname, { method = 'GET', body } = {}) {
  const { auth } = jiraConfig()
  const candidates = await bases()
  let last = null
  for (const base of candidates) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 204) { RESOLVED_BASE = base; return {} }
    const text = await res.text()
    if (res.ok) { RESOLVED_BASE = base; return text ? JSON.parse(text) : {} }
    last = { status: res.status, text, base }
    // 401/403/404 on the site URL is exactly what a scoped token looks like — try the gateway.
    if (![401, 403, 404].includes(res.status)) break
  }
  throw new Error(`Jira ${method} ${pathname} -> ${last.status} (base ${last.base}): ${last.text.slice(0, 400)}`)
}

/** Which base ended up working — for diagnostics only. */
export const resolvedBase = () => RESOLVED_BASE

/**
 * Raw status probe. Jira Cloud answers an issue the caller may not READ with **404, not 401** — so
 * "does not exist", "wrong project permission" and "bad token" are indistinguishable from the
 * status code alone. This asks `/myself` as well, which separates them: a working token that gets
 * 404 on an issue means a permission or key problem, not an auth problem.
 */
export async function probeIssue(key) {
  const { host, email, dirty, auth } = jiraConfig()
  const candidates = await bases()
  const get = async (base, p) => {
    try {
      const r = await fetch(`${base}${p}`, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      return { status: r.status, body: (await r.text()).slice(0, 300) }
    } catch (e) { return { status: 0, body: String(e.message) } }
  }

  // READING THE ISSUE is the only thing that matters. /myself needs the read:jira-user scope, which
  // a write-scoped token does not have, so a 401 there says nothing about whether the agent can
  // work — treating it as fatal is what refused a perfectly good token on the first CI run.
  let me = { status: 0 }, issue = { status: 0 }, usedBase = candidates[0], kind = ''
  for (const base of candidates) {
    usedBase = base
    kind = base.includes('api.atlassian.com') ? 'scoped token via api.atlassian.com' : 'classic token via the site URL'
    me = await get(base, '/rest/api/3/myself')
    issue = await get(base, `/rest/api/3/issue/${encodeURIComponent(key)}`)
    if (issue.status === 200) break
  }

  const where = `${host} as ${email} (${kind})`
  let verdict
  if (issue.status === 200) {
    verdict = me.status === 200 ? `readable — ${kind}` : `readable — ${kind}; /myself is 401 because the token lacks read:jira-user, which is fine`
  } else if (issue.status === 401 || me.status === 401) {
    verdict = [
      `Jira rejected the credentials on both the site URL and the api.atlassian.com gateway — ${where}.`,
      'In order of likelihood:',
      '  1. the TOKEN expired or was revoked — make a new one at',
      '     id.atlassian.com/manage-profile/security/api-tokens',
      `  2. the EMAIL is not the Atlassian account that owns the token (currently ${email})`,
      `  3. the SITE does not own ${key} — check the URL you use in the browser`,
      dirty.length ? `  (${dirty.join(', ')} had quotes or whitespace; that was stripped before this call)` : '',
    ].filter(Boolean).join('\n')
  } else if (issue.status === 404) {
    verdict = `the credentials work on ${where}, but ${key} is not readable — either that key does not exist on this site, ` +
      'or this user lacks Browse Projects on its project (Jira answers 404, not 403, for both).'
  } else if (issue.status === 0) verdict = `could not reach Jira: ${issue.body}`
  else verdict = `issue -> ${issue.status} on ${where}`
  return { me: me.status, issue: issue.status, base: usedBase, kind, verdict, body: issue.body }
}

/**
 * Is this comment one the agent wrote itself?
 *
 * ESI2-3393 refused at intake with "a fix was already shipped" — citing seven draft PRs that the
 * agent had opened on its own earlier runs. Its own footprints, read back as somebody else's work.
 * Every run comments on the ticket, so this feedback loop grows with every attempt and poisons
 * every judgement intake makes about history.
 *
 * The comments are posted under the OPERATOR's Jira account, so the author field cannot separate
 * them. The signature the agent writes can, and it is a line this codebase controls.
 */
export const AGENT_MARK = '<!-- panda-agent -->'

export function isAgentComment(body, agent) {
  // Guarded because `comments.filter(isAgentComment)` is the obvious call and passes the array
  // INDEX as the second argument, which would silently match nothing.
  const name = typeof agent === 'string' && agent ? agent : (process.env.PAG_AGENT_NAME || 'panda-agent')
  const t = String(body || '').trimStart()
  if (t.includes(AGENT_MARK)) return true              // everything written from now on
  // Legacy: comments already on tickets carry no marker. Every one of them OPENS with the agent's
  // name and a report verb — "panda-agent opened a draft PR", "panda-agent-graph stopped at
  // `intake`". Both halves are required, so a human writing "panda-agent picked the wrong file"
  // is not swallowed.
  if (!t.startsWith(name)) return false
  return /^.{0,80}?(opened a|stopped at|could not finish|refused|No branch pushed)/is.test(t)
}

/** One issue, redacted, comments included. Returns null when unreadable rather than throwing. */
export async function fetchIssue(key) {
  let raw
  try {
    raw = await api(`/rest/api/3/issue/${encodeURIComponent(key)}?expand=renderedFields`)
  } catch (e) {
    if (/-> 404/.test(String(e))) return null
    throw e
  }
  const f = raw.fields || {}
  const clean = (t) => redact(t || '').text

  return {
    key: raw.key,
    summary: clean(f.summary),
    description: clean(adfToText(f.description)),
    issuetype: f.issuetype?.name || '',
    priority: f.priority?.name || '',
    status: f.status?.name || '',
    labels: f.labels || [],
    assignee: f.assignee?.displayName || null,
    // The agent's own PR notices are filtered out here, at the boundary, so no node can mistake
    // them for engineering history. `agentComments` keeps the count for the run log.
    comments: (f.comment?.comments || [])
      .map((c) => ({ author: c.author?.displayName || 'unknown', body: clean(adfToText(c.body)) }))
      .filter((c) => !isAgentComment(c.body))
      .slice(0, 10),
    agentComments: (f.comment?.comments || []).filter((c) => isAgentComment(adfToText(c.body))).length,
    attachments: (f.attachment || []).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size, content: a.content })),
  }
}

/**
 * The ticket's screenshots, as bytes a vision model can read.
 *
 * Reporters put the decisive facts in images: which SCREEN the error is on, the exact error text,
 * the field's configuration, the value that failed. ESI2-3393's text says "map the fields and click
 * Next — an error is displayed"; the screenshot is what shows it is OneSchema's validation, not the
 * backend importer. Six runs read the text and patched the backend. This is why intake now looks.
 *
 * Bounded: PNG/JPEG/GIF/WebP only, `max` files, `maxBytes` each. Goes through the same base
 * resolution as every other call — a scoped token cannot fetch from the site URL. Any failure is a
 * skipped image, never a failed run.
 */
export async function fetchAttachmentImages(ticket, { max = 6, maxBytes = 2 * 1024 * 1024 } = {}) {
  const FORMAT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' }
  const pick = (ticket?.attachments || [])
    .filter((a) => FORMAT[a.mimeType] && a.id && (!a.size || a.size <= maxBytes))
    .slice(0, max)
  if (!pick.length) return []
  const { auth } = jiraConfig()
  const candidates = await bases()
  const out = []
  for (const a of pick) {
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/rest/api/3/attachment/content/${a.id}`, {
          headers: { Authorization: auth }, redirect: 'follow', signal: AbortSignal.timeout(20_000),
        })
        if (!res.ok) { if ([401, 403, 404].includes(res.status)) continue; break }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > maxBytes) break
        out.push({ filename: a.filename, format: FORMAT[a.mimeType], bytes: buf })
        break
      } catch { /* next base, or skip */ }
    }
  }
  return out
}

export async function addComment(key, markdown) {
  return api(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    body: { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown.slice(0, 30000) }] }] } },
  })
}

/** Every transition the ticket can make RIGHT NOW, from its current status. */
export async function listTransitions(key) {
  const { transitions = [] } = await api(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
  return transitions.map((t) => ({ id: t.id, name: t.name, to: t.to?.name }))
}

/** The status the ticket is in now. */
export async function currentStatus(key) {
  const r = await api(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`)
  return r?.fields?.status?.name || null
}

/**
 * Move the ticket, tolerantly, trying several names in order.
 *
 * Two things make an exact-match transition useless in practice. Board workflows rename columns
 * constantly ("In Review" / "Code Review" / "Peer Review" / "In QA" are the same column on four
 * different boards), and Jira only offers the transitions valid FROM THE CURRENT STATUS — so a
 * ticket sitting in To Do may have no path to Done at all without passing through In Progress.
 *
 * So `wanted` is a list of candidates in preference order, and this returns what it actually did
 * plus everything that was on offer, which is what you need in the log when it does nothing.
 *
 * @param {string} key
 * @param {string|string[]} wanted  candidate transition names, best first
 */
export async function transition(key, wanted) {
  const candidates = (Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean)
  const transitions = await listTransitions(key)
  if (!transitions.length) return { moved: false, reason: 'no transitions are available from the current status', available: [] }

  const norm = (x) => String(x).toLowerCase().replace(/[^a-z]/g, '')
  for (const want of candidates) {
    const target = norm(want)
    // Match the transition's own name OR the status it lands in — boards commonly name the
    // transition "Start review" and the destination column "In Review", and the ticket says the
    // destination.
    const hit = transitions.find((t) => norm(t.name) === target || norm(t.to) === target)
      || transitions.find((t) => norm(t.name).includes(target) || norm(t.to || '').includes(target))
      || transitions.find((t) => target.includes(norm(t.name)))
    if (!hit) continue
    await api(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: { transition: { id: hit.id } } })
    return { moved: true, to: hit.to || hit.name, via: hit.name, matched: want, available: transitions.map((t) => t.name) }
  }
  return { moved: false, reason: `none of ${candidates.join(' / ')} matched`, available: transitions.map((t) => `${t.name} -> ${t.to}`) }
}
