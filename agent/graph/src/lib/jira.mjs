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

async function api(pathname, { method = 'GET', body } = {}) {
  const { url, auth } = jiraConfig()
  const res = await fetch(`${url}${pathname}`, {
    method,
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return {}
  const text = await res.text()
  if (!res.ok) throw new Error(`Jira ${method} ${pathname} -> ${res.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : {}
}

/**
 * Raw status probe. Jira Cloud answers an issue the caller may not READ with **404, not 401** — so
 * "does not exist", "wrong project permission" and "bad token" are indistinguishable from the
 * status code alone. This asks `/myself` as well, which separates them: a working token that gets
 * 404 on an issue means a permission or key problem, not an auth problem.
 */
export async function probeIssue(key) {
  const { url, auth } = jiraConfig()
  const get = async (p) => {
    const r = await fetch(`${url}${p}`, { headers: { Authorization: auth, Accept: 'application/json' } })
    return { status: r.status, body: (await r.text()).slice(0, 300) }
  }
  const { host, email, dirty } = jiraConfig()
  const me = await get('/rest/api/3/myself')
  const issue = await get(`/rest/api/3/issue/${encodeURIComponent(key)}`)
  const where = `site ${host} as ${email}`
  let verdict
  if (me.status === 401) {
    verdict = [
      `Jira rejected the credentials (401 on /myself) — ${where}.`,
      'Check, in this order:',
      `  1. the SITE: does ${host} own ${key}? A key from another Jira site cannot be read here.`,
      '  2. the EMAIL: it must be the Atlassian account the API token was created under.',
      '  3. the TOKEN: create a fresh one at id.atlassian.com/manage-profile/security/api-tokens',
      '     and paste it with NO quotes, NO spaces and NO trailing newline.',
      dirty.length ? `     (note: ${dirty.join(', ')} had quotes/whitespace, which was stripped before this call)` : '',
    ].filter(Boolean).join('\n')
  } else if (me.status !== 200) verdict = `cannot identify the token holder (myself -> ${me.status}) on ${where}`
  else if (issue.status === 200) verdict = 'readable'
  else if (issue.status === 404) {
    verdict = `the token works on ${where}, but ${key} is not readable by it — either that key does not exist on this site, ` +
      'or this user lacks Browse Projects on its project (Jira answers 404, not 403, for both).'
  } else verdict = `issue -> ${issue.status} on ${where}`
  return { me: me.status, issue: issue.status, verdict, body: issue.body }
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
    comments: (f.comment?.comments || []).slice(0, 10).map((c) => ({
      author: c.author?.displayName || 'unknown',
      body: clean(adfToText(c.body)),
    })),
    attachments: (f.attachment || []).map((a) => ({ filename: a.filename, mimeType: a.mimeType, content: a.content })),
  }
}

export async function addComment(key, markdown) {
  return api(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    body: { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown.slice(0, 30000) }] }] } },
  })
}

/**
 * Move the ticket by TRANSITION NAME, tolerantly. Board workflows rename these constantly, so an
 * exact-match-or-fail transition is a run that dies on a board config change. Falls back to the
 * closest available name and reports what it actually did.
 */
export async function transition(key, wanted) {
  const { transitions = [] } = await api(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
  const norm = (x) => x.toLowerCase().replace(/[^a-z]/g, '')
  const target = norm(wanted)
  const exact = transitions.find((t) => norm(t.name) === target)
  const fuzzy = exact || transitions.find((t) => norm(t.name).includes(target) || target.includes(norm(t.name)))
  if (!fuzzy) return { moved: false, available: transitions.map((t) => t.name) }
  await api(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: { transition: { id: fuzzy.id } } })
  return { moved: true, to: fuzzy.name, exact: Boolean(exact) }
}
