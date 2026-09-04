#!/usr/bin/env node
// Webhook receiver. Validates, dedupes, enqueues, returns. Does NO work.
//
// Jira Automation's "Send web request" times out at 30 seconds and the timeout is not
// configurable, so anything that touches a model or git must happen elsewhere. This process
// answers in milliseconds and hands the run to SQS.
//
// Why Automation rather than a Jira webhook: Jira Cloud webhook delivery has been reported
// degraded since 20 April 2026 — latency from 1 second to 28 minutes, and outright drops — still
// reproduced in August. Automation is the more reliable trigger in 2026.
//
// Why a LABEL rather than an assignee: Atlassian Cloud service accounts CANNOT be assignees.
// The sanctioned way to make a real external agent assignable is Forge's `rovo-agent-connector`
// (preview). Until that ships, "assign the agent" is `label = agent-run`, which has the useful
// side effect of leaving the human assignee intact — that is who gets @mentioned for approval.
//
// Idempotency, three independent layers, because Jira is explicitly at-least-once and the
// assignee trigger is known to double-fire:
//   1. a dedupe key header, remembered here with a TTL
//   2. a deterministic thread_id derived from the issue key, so a duplicate resumes the existing
//      LangGraph thread instead of starting a second run
//   3. the rule itself gated on the label, which the workflow flips to `agent-running` on pickup

import '../src/lib/boot.mjs'   // loads graph/.env before anything reads process.env
import http from 'node:http'
import crypto from 'node:crypto'

const PORT = Number(process.env.PORT || 8080)
const SECRET = process.env.PAG_WEBHOOK_SECRET
const QUEUE_URL = process.env.PAG_QUEUE_URL
const TRIGGER_LABEL = process.env.PAG_TRIGGER_LABEL || 'agent-run'

if (!SECRET) { console.error('PAG_WEBHOOK_SECRET is required'); process.exit(1) }

// Bounded, TTL'd dedupe. Single-instance memory is enough because layer 2 (the deterministic
// thread_id) is the real guarantee; this just avoids the wasted enqueue.
const TTL_MS = 10 * 60_000
const seen = new Map()
const alreadySeen = (key) => {
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > TTL_MS) seen.delete(k)
  if (seen.has(key)) return true
  seen.set(key, now)
  return false
}

const timingSafe = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b))
  return A.length === B.length && crypto.timingSafeEqual(A, B)
}

async function enqueue(body) {
  if (!QUEUE_URL) { console.log('[dry] would enqueue', JSON.stringify(body)); return 'dry-run' }
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs')
  const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' })
  const res = await sqs.send(new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify(body),
    // FIFO dedupe as a fourth layer where the queue supports it.
    MessageGroupId: body.issueKey,
    MessageDeduplicationId: body.dedupeKey.slice(0, 128),
  }))
  return res.MessageId
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true })
  if (req.method !== 'POST' || req.url !== '/jira') return json(res, 404, { error: 'not found' })

  if (!timingSafe(req.headers['x-pag-secret'] || '', SECRET)) return json(res, 401, { error: 'bad secret' })

  let raw = ''
  req.on('data', (d) => { raw += d; if (raw.length > 1 << 20) req.destroy() })
  req.on('end', async () => {
    let p
    try { p = JSON.parse(raw) } catch { return json(res, 400, { error: 'bad json' }) }

    // Automation sends whatever the rule's payload template defines. Keep it minimal:
    //   { "issueKey": "{{issue.key}}", "labels": "{{issue.labels}}",
    //     "dedupeKey": "{{issue.key}}-{{issue.updated}}-{{rule.id}}" }
    const issueKey = String(p.issueKey || '').trim()
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(issueKey)) return json(res, 400, { error: 'missing or malformed issueKey' })

    const labels = String(p.labels || '')
    if (TRIGGER_LABEL && !labels.includes(TRIGGER_LABEL)) {
      return json(res, 200, { skipped: `label ${TRIGGER_LABEL} not present`, issueKey })
    }

    const dedupeKey = String(p.dedupeKey || `${issueKey}-${Date.now()}`)
    if (alreadySeen(dedupeKey)) return json(res, 200, { deduped: true, issueKey, dedupeKey })

    try {
      const messageId = await enqueue({
        issueKey,
        dedupeKey,
        // Deterministic: a re-delivery resumes this thread rather than opening a second run.
        threadId: `jira:${issueKey}`,
        baseBranch: process.env.PAG_BASE_BRANCH || 'main',
        prTargetBranch: process.env.PAG_PR_TARGET || 'qa',
        receivedAt: new Date().toISOString(),
      })
      console.log(`queued ${issueKey} (${dedupeKey}) -> ${messageId}`)
      return json(res, 202, { queued: true, issueKey, messageId })
    } catch (err) {
      console.error(`enqueue failed for ${issueKey}:`, err.message)
      // 5xx so Jira Automation surfaces it in the rule's audit log rather than silently succeeding.
      return json(res, 503, { error: 'enqueue failed' })
    }
  })
}).listen(PORT, () => {
  console.log(`pag receiver on :${PORT}  POST /jira  ·  trigger label "${TRIGGER_LABEL}"  ·  queue ${QUEUE_URL || '(dry-run)'}`)
})
