#!/usr/bin/env node
// The production worker. One SQS message -> one worktree -> one graph run -> worktree destroyed.
//
// Runs as an ECS Fargate task. Fargate is the right compute here for a specific reason: an ECS
// task has NO maximum runtime, while Lambda is capped at 900 seconds — and the patch node alone
// can legitimately run 20 minutes. Ephemeral storage (20 GiB default, up to 200 GiB) is where the
// worktree lives and is destroyed with the task, which is exactly the lifecycle we want.
//
// Recovery model, stated plainly because LangGraph does not provide it: a checkpointer STORES
// state, it does not SUPERVISE. Nothing resumes a crashed run for you. So the durability comes
// from SQS: set the visibility timeout above the worst-case run, and if this task dies the message
// reappears and a new task picks it up. Because `threadId` is derived from the issue key, resuming
// with a `null` input continues from the last checkpoint rather than starting over.
//
// Checkpoints are written per SUPERSTEP, not inside a node — so a crash mid-patch re-runs that
// node from its first line. Every node is therefore idempotent by construction: the branch name
// is derived from the issue key, worktree creation tolerates an existing directory, and PR
// creation upserts.

import '../src/lib/boot.mjs'   // loads graph/.env before anything reads process.env
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildGraph } from '../src/graph.mjs'
import { Budget } from '../src/lib/budget.mjs'
import { Trace } from '../src/lib/trace.mjs'
import * as snap from '../src/lib/snapshot.mjs'
import { addComment, transition } from '../src/lib/jira.mjs'
import { stopApp } from '../src/lib/app.mjs'

const exec = promisify(execFile)
const REPO_URL = process.env.PAG_REPO_URL                    // git@github.com:owner/pioneer.git
const CACHE = process.env.PAG_REPO_CACHE || '/var/cache/pag/repo'
const ONCE = process.argv.includes('--once')

const need = (n) => { if (!process.env[n]) { console.error(`${n} is required`); process.exit(1) } }
need('PAG_REPO_URL'); need('PAG_QUEUE_URL')

/** A bare-ish cached clone, so each run fetches a delta instead of the whole monorepo. */
async function ensureCache() {
  if (!fs.existsSync(path.join(CACHE, '.git'))) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true })
    console.log(`cloning ${REPO_URL} -> ${CACHE} (once per task/volume)`)
    await exec('git', ['clone', '--filter=blob:none', REPO_URL, CACHE], { maxBuffer: 1 << 26 })
  }
  await exec('git', ['fetch', 'origin', '--prune'], { cwd: CACHE, maxBuffer: 1 << 26 })
}

async function withWorktree(issueKey, baseSha, fn) {
  await ensureCache()
  const dir = path.join(os.tmpdir(), `pag-${issueKey}-${Date.now()}`)
  // Same naming as bin/run.mjs, so a run tested locally and a run from the queue are the same run.
  const branch = `${process.env.PAG_BRANCH_PREFIX || 'agent/'}${issueKey}-fix`

  // Detached at the PINNED sha — never live origin/<base>. publish creates the branch from
  // s.baseSha itself, so a resumed run cannot collide with a half-made branch.
  await exec('git', ['worktree', 'add', '--detach', dir, baseSha], { cwd: CACHE, maxBuffer: 1 << 26 })
  try {
    return await fn({ dir, branch })
  } finally {
    await exec('git', ['worktree', 'remove', '--force', dir], { cwd: CACHE }).catch(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await exec('git', ['worktree', 'prune'], { cwd: CACHE }).catch(() => {})
  }
}

async function handle(msg) {
  const { issueKey, threadId, baseBranch = 'main', prTargetBranch = 'qa' } = msg
  console.log(`\n=== ${issueKey} (thread ${threadId}) ===`)

  // Claim it visibly, in the place a human is looking. Best-effort — a Jira hiccup must not
  // abort a run that is otherwise fine.
  await transition(issueKey, 'In Progress').catch((e) => console.log(`transition skipped: ${e.message}`))

  // The pin is the contract with the refresher (bin/refresh.mjs): the commit whose index, history
  // and per-project baselines are READY. Identical to what bin/run.mjs does — one code path.
  const pin = snap.readPin()
  if (!pin || pin.base !== baseBranch) {
    const detail = pin
      ? `snapshot is pinned to base "${pin.base}" but this run asked for "${baseBranch}"`
      : 'no snapshot pin — run bin/refresh.mjs (or bin/baseline.mjs) first'
    console.error(detail)
    await addComment(issueKey, `panda-agent-graph could not run: ${detail}`).catch(() => {})
    return { refusal: { at: 'preflight', reason: 'no_snapshot', detail } }
  }
  const baseSha = pin.sha
  console.log(`  base ${baseBranch}@${baseSha.slice(0, 7)} (pinned ${snap.pinAgeHours().toFixed(1)}h ago) -> PR into ${prTargetBranch}`)

  return withWorktree(issueKey, baseSha, async ({ dir, branch }) => {
    const budget = new Budget()
    const runId = new Date().toISOString().replace(/[:.]/g, '-')
    const trace = new Trace({ issueKey, runId })
    process.env.PAG_RUN_DIR = trace.dir
    const onProgress = (l) => { trace.note('worker', l); process.stdout.write(`   ${String(l).trim().slice(0, 200)}\n`) }

    const { PostgresSaver } = await import('@langchain/langgraph-checkpoint-postgres')
    const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URI)
    await checkpointer.setup()

    const graph = buildGraph({ budget, checkpointer, trace, onProgress })
    const input = { issueKey, repo: dir, baseBranch, prTargetBranch, baseSha, branchName: branch }

    let final = {}
    // `durability: 'sync'` — when one node costs 20 minutes of Opus, a few hundred ms per
    // superstep to never redo it is obviously the right trade.
    for await (const chunk of await graph.stream(input, {
      configurable: { thread_id: threadId },
      recursionLimit: 40,
      streamMode: 'updates',
      durability: 'sync',
    })) {
      for (const [node, update] of Object.entries(chunk)) {
        console.log(`  ▸ ${node.padEnd(9)} $${budget.report().spent.toFixed(4)}`)
        final = { ...final, ...update }
      }
      trace.timeline(budget.report())
    }

    console.log(trace.timeline(budget.report()))
    stopApp()   // the witness dev server belongs to THIS worktree; the next run gets its own
    return final
  })
}

async function main() {
  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs')
  const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' })
  const QueueUrl = process.env.PAG_QUEUE_URL

  for (;;) {
    const { Messages } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20,
    }))
    if (!Messages?.length) { if (ONCE) return; continue }

    const m = Messages[0]
    let body
    try { body = JSON.parse(m.Body) } catch {
      console.error('unparseable message, deleting'); 
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }))
      continue
    }

    try {
      await handle(body)
      // Delete only on a clean finish. A refusal IS clean — it is a terminal outcome, not a
      // failure to retry. A throw leaves the message to reappear after the visibility timeout.
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }))
    } catch (err) {
      console.error(`run threw for ${body.issueKey}:`, err.stack || err.message)
      // Left on the queue deliberately: it will redeliver and resume from the last checkpoint,
      // and after maxReceiveCount it lands in the DLQ for a human.
    }
    if (ONCE) return
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
