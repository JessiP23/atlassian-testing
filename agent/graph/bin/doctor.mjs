#!/usr/bin/env node
// Readiness report. One command that answers "will a run work here", and when it will not, WHICH
// of the four external systems is the reason and what to do about it.
//
//   node bin/doctor.mjs --key ABC-123
//   node bin/doctor.mjs --key ABC-123 --comment      # also post a real test comment (write proof)
//
// Built for the move onto a company Jira and a company GitHub org, where you do not own any of the
// credentials and "it didn't work" is not a useful thing to report to the person who does. Every
// row names the system, the verdict, and the exact fix. In CI it also writes the table to the job
// summary, so the output is something you can screenshot into a Slack thread.
//
// Exit code is 1 if anything FAILED, 0 otherwise. WARN never fails the job.

import '../src/lib/boot.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { jiraConfig, probeIssue, listTransitions, currentStatus, addComment } from '../src/lib/jira.mjs'
import { converse } from '../src/lib/bedrock.mjs'
import { TIERS } from '../src/lib/models.mjs'
import { loadProfile } from '../profiles/index.mjs'

const exec = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }
const has = (n) => argv.includes(`--${n}`)
const repo = path.resolve(String(flag('repo', process.env.GITHUB_WORKSPACE || process.cwd() + '/../..')))
const key = flag('key', process.env.ISSUE_KEY || '')

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m'
const rows = []
let group = ''
const G_ = (name) => { group = name; console.log(`\n${B}${name}${X}`) }
const add = (verdict, what, detail = '', fix = '') => {
  rows.push({ group, verdict, what, detail, fix })
  const c = verdict === 'PASS' ? G : verdict === 'FAIL' ? R : Y
  console.log(`  ${c}${verdict.padEnd(4)}${X} ${what}${detail ? `\n         ${D}${detail}${X}` : ''}${fix && verdict !== 'PASS' ? `\n         ${Y}→ ${fix}${X}` : ''}`)
}
const ok = (...a) => add('PASS', ...a)
const bad = (...a) => add('FAIL', ...a)
const warn = (...a) => add('WARN', ...a)

// ─────────────────────────── Jira ───────────────────────────
G_('Jira')
let cfg = null
try {
  cfg = jiraConfig()
  ok('credentials present', `${cfg.url} as ${cfg.email}`)
  if (cfg.dirty) warn('the stored token has quote or whitespace characters in it',
    'the sanitiser strips them, but the value stored in the secret is wrong',
    're-paste JIRA_API_TOKEN with no surrounding quotes')
} catch (e) {
  bad('credentials', e.message, 'set JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN as Actions secrets')
}

if (cfg && !key) {
  warn('no ticket to probe', 'pass --key ABC-123 to check read access, transitions and the board\'s column names')
} else if (cfg) {
  const p = await probeIssue(key).catch((e) => ({ ok: false, reason: e.message }))
  if (p.ok) {
    ok(`can read ${key}`, `via ${p.base || 'the site URL'}`)
  } else {
    // A scoped token 401s on the site URL and only works through api.atlassian.com; an unauthorised
    // issue answers 404, not 403, so "not found" usually means "no permission on that project".
    bad(`cannot read ${key}`, p.reason || 'unknown',
      'a 404 here usually means the token has no permission on that PROJECT, not that the key is wrong — ask for the agent account to be added to it')
  }

  if (p.ok) {
    const st = await currentStatus(key).catch(() => null)
    const ts = await listTransitions(key).catch(() => [])
    if (ts.length) {
      ok(`transitions readable — ${key} is in "${st}"`, ts.map((t) => `${t.name} -> ${t.to}`).join('  |  '))
      // These are the two values the run needs, and they are the ones nobody can guess for you.
      const names = ts.map((t) => `${t.name} ${t.to}`.toLowerCase())
      const hasReview = names.some((n) => /review|qa/.test(n))
      const hasDone = names.some((n) => /done|closed|resolved|complete/.test(n))
      if (!hasReview) warn('no review-ish transition from this status',
        'the agent moves a ticket to review when it opens the PR',
        `set PAG_JIRA_TRANSITION to one of: ${ts.map((t) => t.name).join(', ')}`)
      if (!hasDone) warn('no done-ish transition from this status',
        'this is normal from To Do — Jira only offers transitions valid from where the ticket is now',
        're-run this against a ticket that is already in review to see the Done path')
    } else {
      warn('no transitions available', 'either the token cannot transition, or the ticket is in a terminal status')
    }

    if (has('comment')) {
      await addComment(key, 'panda-agent doctor: write access confirmed. This comment can be deleted.')
        .then(() => ok('can comment (write access confirmed)'))
        .catch((e) => bad('cannot comment', e.message, 'the token needs write:jira-work — read-only will fail at publish'))
    } else {
      warn('write access not tested', 'read worked; commenting and transitioning are separate scopes', 're-run with --comment to prove it')
    }
  }
}

// ─────────────────────────── GitHub ───────────────────────────
G_('GitHub')
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const allowed = (process.env.PAG_ALLOWED_REMOTE || '').trim()
if (!token) bad('no token', 'GH_TOKEN / GITHUB_TOKEN is unset', 'add GH_TOKEN as an Actions secret (fine-grained: contents:write, pull_requests:write, metadata:read)')
if (!allowed) bad('PAG_ALLOWED_REMOTE is unset', 'the agent refuses to push when it does not know which repo it may push to', 'set it to owner/repo — the fork, not the upstream')

let originSlug = null
try {
  const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repo })
  originSlug = (stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/) || [])[1] || null
  if (allowed && originSlug && originSlug.toLowerCase() !== allowed.toLowerCase()) {
    bad('origin does not match PAG_ALLOWED_REMOTE', `origin is ${originSlug}, allowed is ${allowed}`,
      'a worktree inherits its parent\'s remotes — this is the guard that stops a push to the upstream repo')
  } else if (originSlug) ok('origin matches the allowed remote', originSlug)
} catch { warn('not a git checkout', repo) }

if (token && allowed) {
  const gh = async (p) => {
    const r = await fetch(`https://api.github.com${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  const r = await gh(`/repos/${allowed}`)
  if (r.status === 200) {
    const perms = r.body.permissions || {}
    ok(`can read ${allowed}`, `default branch: ${r.body.default_branch}${r.body.fork ? ' (a fork — good)' : ''}`)
    if (perms.push) ok('token can push branches')
    else bad('token cannot push', 'contents:write is missing', 'the run will reach publish and fail there')
    // Workflows only ever dispatch from the DEFAULT branch. A workflow perfect on a feature branch
    // simply never fires, and there is no error anywhere to tell you why.
    const wf = await gh(`/repos/${allowed}/contents/.github/workflows/agent-ticket-to-pr.yml?ref=${r.body.default_branch}`)
    if (wf.status === 200) ok(`the workflow is on ${r.body.default_branch}`)
    else bad(`agent-ticket-to-pr.yml is NOT on ${r.body.default_branch}`, `HTTP ${wf.status}`,
      'repository_dispatch only fires workflows that exist on the default branch — merge it there or nothing happens, silently')
    const merged = await gh(`/repos/${allowed}/contents/.github/workflows/agent-pr-merged.yml?ref=${r.body.default_branch}`)
    if (merged.status === 200) ok(`the merge-close workflow is on ${r.body.default_branch}`)
    else warn('agent-pr-merged.yml is not on the default branch', 'tickets will not move to Done on merge')
  } else if (r.status === 404) {
    bad(`cannot see ${allowed}`, 'HTTP 404', 'either the repo name is wrong or the token has no access to it — 404 is what GitHub returns for both')
  } else {
    bad(`cannot read ${allowed}`, `HTTP ${r.status} ${r.body.message || ''}`)
  }
}

// ─────────────────────────── Bedrock ───────────────────────────
G_('Bedrock')
const models = [['fast', TIERS.fast.model], ['heavy', TIERS.heavy.model]]
for (const [tier, model] of models) {
  const t0 = Date.now()
  try {
    await converse({ model, system: 'Reply with the single word: ok', user: 'ping', maxTokens: 8 })
    ok(`${tier} model answers`, `${model} · ${Date.now() - t0}ms`)
  } catch (e) {
    const m = String(e.message || e)
    bad(`${tier} model does not answer`, `${model} — ${m.split('\n')[0].slice(0, 140)}`,
      /AccessDenied|not authorized/i.test(m) ? 'the IAM identity lacks bedrock:InvokeModel for this model'
        : /ValidationException|not found|inference profile/i.test(m) ? 'the model is not enabled in this account/region — Bedrock console → Model access'
        : /ExpiredToken|security token/i.test(m) ? 'AWS credentials are expired'
        : 'check AWS_REGION and the credentials in this environment')
  }
}

// ─────────────────────────── the repo and the runner ───────────────────────────
G_('Repo and runner')
try {
  const profile = loadProfile(repo)
  const plan = profile.gate(repo, { owners: ['app'], typeConsumers: [] })
  ok(`profile: ${profile.name}`, `gate: ${plan.map((c) => c.target + (c.exclusive ? ' (alone)' : '')).join(', ') || 'nothing — no lint/test/build scripts found'}`)
  if (!plan.length) warn('the gate has no commands', 'nothing will verify the patch beyond the reproducing test')
  if (profile.hasUnitRunner(repo)) ok('unit test runner available', 'the reproducing test can be a real unit test — the cheapest and most reliable evidence rung')
  else warn('no unit test runner in this repo', 'the browser witness is the only evidence rung; the plan will not ask for unit tests')
} catch (e) { bad('profile', e.message) }

for (const [cmd, args, label, fix] of [
  ['node', ['--version'], 'node', ''],
  ['claude', ['--version'], 'claude-code CLI', 'npm i -g @anthropic-ai/claude-code — the patch node shells out to it'],
  ['ffmpeg', ['-version'], 'ffmpeg', 'only needed for the walkthrough GIF; screenshots work without it'],
]) {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 15_000 })
    ok(label, stdout.trim().split('\n')[0].slice(0, 60))
  } catch {
    if (label === 'ffmpeg') warn(`${label} not installed`, '', fix)
    else bad(`${label} not installed`, '', fix)
  }
}

if (process.env.PAG_UI_EVIDENCE === '1') {
  const cache = process.platform === 'darwin'
    ? path.join(process.env.HOME, 'Library/Caches/ms-playwright')
    : path.join(process.env.HOME, '.cache/ms-playwright')
  if (fs.existsSync(cache) && fs.readdirSync(cache).some((d) => /chromium/.test(d))) ok('Playwright chromium installed')
  else bad('Playwright chromium missing', `looked in ${cache}`, 'npx --prefix agent/graph playwright install --with-deps chromium')
}

// ─────────────────────────── report ───────────────────────────
const fails = rows.filter((r) => r.verdict === 'FAIL')
const warns = rows.filter((r) => r.verdict === 'WARN')
console.log(`\n${B}${rows.filter((r) => r.verdict === 'PASS').length} passed · ${warns.length} warning · ${fails.length} failed${X}`)
if (fails.length) console.log(`${R}Not ready. Fix the FAIL rows above; each one stops a run at a different phase.${X}\n`)
else console.log(`${G}Ready. Run the workflow with dry run checked first.${X}\n`)

if (process.env.GITHUB_STEP_SUMMARY) {
  const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const icon = { PASS: '✅', WARN: '⚠️', FAIL: '❌' }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `## Agent readiness${key ? ` — ${key}` : ''}`,
    '',
    `**${rows.filter((r) => r.verdict === 'PASS').length} passed · ${warns.length} warning · ${fails.length} failed**`,
    '',
    '| | System | Check | Detail | Fix |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${icon[r.verdict]} | ${r.group} | ${esc(r.what)} | ${esc(r.detail).slice(0, 160)} | ${r.verdict === 'PASS' ? '' : esc(r.fix)} |`),
    '',
  ].join('\n') + '\n')
}

process.exit(fails.length ? 1 : 0)
