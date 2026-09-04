#!/usr/bin/env node
// Preflight. One command that answers "is this workflow wired correctly", before any spend.
//
//   node bin/preflight.mjs --repo ~/pioneer-agent --base main
//
// Every check here exists because it silently failed once. The most important is IDENTITY: the
// monthly budget guardrail is an AWS Budgets action that attaches a deny-Bedrock policy to the
// `panda-code-agent` IAM user. Running as an SSO admin means that cap CANNOT apply to you — you
// get no hard spend ceiling, and no per-agent cost attribution. On the previous run every phase
// printed "Multiple credential sources detected … will proceed with AWS_PROFILE" and nobody
// noticed, so a $7 run was billed to an admin identity outside the guardrail.

import '../src/lib/boot.mjs'   // loads graph/.env before anything reads process.env
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { TIERS, NODE_TIER } from '../src/lib/models.mjs'
import * as snap from '../src/lib/snapshot.mjs'

const exec = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }
const repo = flag('repo') ? path.resolve(String(flag('repo')).replace(/^~/, process.env.HOME)) : null
const base = String(flag('base', 'main'))

const OK = '  \x1b[32m✓\x1b[0m', BAD = '  \x1b[31m✗\x1b[0m', WARN = '  \x1b[33m!\x1b[0m'
let fatal = 0, warn = 0
const ok = (m, d) => console.log(`${OK} ${m}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`)
const bad = (m, fix) => { fatal++; console.log(`${BAD} ${m}`); if (fix) console.log(`      \x1b[2m→ ${fix}\x1b[0m`) }
const nag = (m, fix) => { warn++; console.log(`${WARN} ${m}`); if (fix) console.log(`      \x1b[2m→ ${fix}\x1b[0m`) }

console.log('\n\x1b[1mIDENTITY\x1b[0m')

// The SDK prefers AWS_PROFILE over static keys. That preference is what put the last run on the
// wrong identity, so it is checked before anything else.
if (process.env.AWS_PROFILE && process.env.AWS_ACCESS_KEY_ID) {
  bad('AWS_PROFILE and static keys are both set — the SDK will use the PROFILE and ignore the keys',
      'unset AWS_PROFILE AWS_SESSION_TOKEN AWS_SECURITY_TOKEN')
} else if (process.env.AWS_PROFILE) {
  nag(`AWS_PROFILE=${process.env.AWS_PROFILE} is set and no static keys are`, 'expected if that profile IS the agent user; otherwise set AWS_ACCESS_KEY_ID/SECRET')
} else if (process.env.AWS_ACCESS_KEY_ID) {
  ok('static access keys in env, no AWS_PROFILE to override them')
} else {
  bad('no AWS credentials in the environment', 'set -a; source .env.local; set +a')
}
if (process.env.AWS_SESSION_TOKEN) {
  nag('AWS_SESSION_TOKEN is set alongside static keys — a stale one causes "security token is invalid"',
      'unset AWS_SESSION_TOKEN AWS_SECURITY_TOKEN')
}

let arn = null
try {
  const { stdout } = await exec('aws', ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'])
  arn = stdout.trim()
  if (/user\/panda-code-agent$/.test(arn)) {
    ok('running as the agent IAM user', arn)
  } else if (/AWSReservedSSO|assumed-role/.test(arn)) {
    bad(`running as ${arn.split('/').slice(-2).join('/')} — NOT panda-code-agent`,
        'the AWS Budgets deny-policy attaches to the panda-code-agent USER only, so an SSO/role identity has NO hard spend cap and spend is not attributable. Use the agent keys.')
  } else {
    nag(`unexpected identity: ${arn}`)
  }
} catch {
  nag('aws cli not available — cannot verify identity', 'brew install awscli, then aws sts get-caller-identity')
}

// Numeric config that silently became NaN is worse than config that is missing: Number(undefined)
// falls back to the default, but Number("30  # comment") is NaN and every comparison against it is
// false — so a cap of NaN disables the budget guard entirely rather than erroring.
for (const [k, dflt] of [['PAG_CAP_USD', 30], ['PAG_RESERVE_USD', 4], ['PAG_MAX_REPAIR', 3], ['PAG_MAX_FILES', 12], ['PAG_MAX_LINES', 400], ['PAG_CANDIDATE_K', 50]]) {
  const raw = process.env[k]
  if (raw !== undefined && Number.isNaN(Number(raw))) {
    bad(`${k}="${raw}" is not a number — the guard it feeds is disabled`, 'quote the value or move the comment to its own line in .env')
  }
}

console.log('\n\x1b[1mMODELS\x1b[0m')
const { converse } = await import('../src/lib/bedrock.mjs')
const tiers = [...new Set(Object.values(NODE_TIER))]
for (const t of tiers) {
  const { model } = TIERS[t]
  const nodes = Object.entries(NODE_TIER).filter(([, v]) => v === t).map(([k]) => k).join(', ')
  const t0 = Date.now()
  try {
    const { text, inTok, outTok } = await converse({ model, system: 'Reply with exactly: OK', user: 'Reply with exactly: OK', maxTokens: 32 })
    if (text) ok(`${t.padEnd(5)} ${model}`, `${Date.now() - t0}ms  ${inTok}in/${outTok}out  → ${nodes}`)
    else bad(`${t} ${model} returned empty text`, 'reasoning model with a starved budget, or a bad model id')
  } catch (e) {
    const m = String(e.message)
    if (/EAI_AGAIN|ENOTFOUND|getaddrinfo/.test(m)) bad(`${t} ${model}: no network route to Bedrock`, 'run this outside a sandboxed shell; DNS to bedrock-runtime is blocked here')
    else if (/AccessDenied|not authorized/i.test(m)) bad(`${t} ${model}: access denied`, 'enable the model in Bedrock → Model access, and check the IAM policy')
    else if (/security token/i.test(m)) bad(`${t} ${model}: invalid security token`, 'unset AWS_SESSION_TOKEN AWS_SECURITY_TOKEN')
    else bad(`${t} ${model}: ${m.slice(0, 110)}`)
  }
}

console.log('\n\x1b[1mSPEND GUARDS\x1b[0m')
try {
  const { stdout } = await exec('aws', ['budgets', 'describe-budgets', '--account-id', (arn || '').split(':')[4] || '', '--output', 'json'])
  const bs = JSON.parse(stdout).Budgets || []
  const b = bs.find((x) => /panda-code-agent/.test(x.BudgetName))
  if (!b) nag('no panda-code-agent-monthly budget found', 'the deny-policy action has nothing to fire from')
  else {
    const limit = Number(b.BudgetLimit?.Amount)
    const spent = Number(b.CalculatedSpend?.ActualSpend?.Amount || 0)
    ok(`budget ${b.BudgetName}`, `$${spent.toFixed(2)} of $${limit} used`)
    const cfg = path.resolve(process.env.HOME, 'pioneer/panda-code-agent/config.json')
    if (fs.existsSync(cfg)) {
      const want = JSON.parse(fs.readFileSync(cfg, 'utf8'))?.cost?.monthlyCapUsd
      if (want && Number(want) !== limit) {
        nag(`config.json says monthlyCapUsd ${want} but the DEPLOYED budget is $${limit}`, 'the CDK budget is authoritative — redeploy the stack, or edit the budget in the console')
      }
    }
  }
} catch (e) {
  // EXPECTED when running as the agent user: the CDK policy grants Bedrock invoke and nothing
  // else, so `budgets:DescribeBudgets` is denied by design. That is least privilege working, not a
  // misconfiguration — the cap is enforced by the Budgets ACTION attaching a deny policy, which
  // needs no read permission on the agent's side. Only nag if we are NOT the agent user, where an
  // unreadable budget really does mean nobody has checked it.
  const denied = /AccessDenied|not authorized|explicit deny/i.test(String(e.message || e))
  if (denied && /user\/panda-code-agent$/.test(arn || '')) {
    ok('budget not readable by the agent user', 'expected — least privilege. Check the cap in the console as admin')
  } else {
    nag('could not read AWS Budgets', 'verify the monthly cap in the console before running unattended')
  }
}
ok('per-run cap', `$${process.env.PAG_CAP_USD || 30} with $${process.env.PAG_RESERVE_USD || 4} held back for publish`)

console.log('\n\x1b[1mJIRA\x1b[0m')
try {
  const { fetchIssue } = await import('../src/lib/jira.mjs')
  const probe = String(flag('issue', 'ESI2-3376'))
  const t = await fetchIssue(probe)
  if (t) ok(`read ${t.key}`, `${t.status} · ${t.comments.length} comments · ${t.attachments.length} attachments`)
  else bad(`${probe} returned 404`, 'wrong issue key, or the token lacks project access')
} catch (e) {
  bad(`Jira: ${String(e.message).slice(0, 120)}`, 'check JIRA_URL (teamassetpanda.atlassian.net), JIRA_EMAIL, JIRA_API_TOKEN')
}

console.log('\n\x1b[1mGITHUB\x1b[0m')
try {
  const { stdout } = await exec('gh', ['auth', 'status'], { env: { ...process.env } })
  const scopes = (stdout.match(/scopes:\s*(.+)/i) || [])[1] || ''
  if (/\brepo\b|\badmin\b/.test(scopes)) nag(`token scopes look broad: ${scopes.trim()}`, 'an agent token should be fine-grained: pull_requests:write + contents:write only — nothing that can merge')
  else ok('gh authenticated', scopes.trim() || 'fine-grained token')
} catch {
  bad('gh not authenticated (or not installed)', 'brew install gh; then GH_TOKEN=... or gh auth login. Needed to open the draft PR')
}

// Which repo may the agent push to? A worktree inherits its parent's remotes, so `origin` is
// almost always the production repo — this is the check that was missing when a branch landed
// on AssetPandaLLC/pioneer.
{
  const allowed = (process.env.PAG_ALLOWED_REMOTE || '').trim()
  const pushRemote = process.env.PAG_PUSH_REMOTE || 'origin'
  let slug = null
  if (repo) {
    try {
      const { stdout } = await exec('git', ['remote', 'get-url', pushRemote], { cwd: repo })
      slug = (stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/) || [])[1] || stdout.trim()
    } catch { /* remote missing — reported below */ }
  }
  if (!allowed) {
    bad('PAG_ALLOWED_REMOTE is not set — publish will refuse rather than risk the wrong repo',
        `add to graph/.env:  PAG_ALLOWED_REMOTE=jessipavia/pioneer`)
  } else if (!repo) {
    nag(`push target ${allowed} declared; pass --repo to confirm the worktree's "${pushRemote}" remote matches`)
  } else if (!slug) {
    bad(`remote "${pushRemote}" does not exist in the worktree`, `git -C ${repo} remote add ${pushRemote} git@github.com:${allowed}.git`)
  } else if (slug.toLowerCase() !== allowed.toLowerCase()) {
    bad(`push remote "${pushRemote}" is ${slug}, but only ${allowed} is allowed`,
        `git -C ${repo} remote add fork git@github.com:${allowed}.git   then set PAG_PUSH_REMOTE=fork`)
  } else {
    ok(`push target ${slug}`, `via remote "${pushRemote}"`)
  }
}

// ---- WITNESS (screenshots + video) — only when enabled -----------------------------------------
console.log('\n\x1b[1mWITNESS\x1b[0m')
if (process.env.PAG_UI_EVIDENCE !== '1') {
  ok('off', 'PAG_UI_EVIDENCE=1 turns on the Playwright witness for web-app tickets')
} else {
  const here = path.resolve(import.meta.dirname, '..')
  if (!fs.existsSync(path.join(here, 'node_modules', '@playwright', 'test'))) bad('@playwright/test is not installed in graph/', 'cd graph && npm install && npx playwright install chromium')
  else {
    try {
      const { stdout } = await exec('npx', ['playwright', '--version'], { cwd: here, timeout: 30_000 })
      ok(`playwright ${stdout.trim().replace(/^Version\s*/, '')}`)
    } catch { bad('npx playwright does not run', 'cd graph && npm install && npx playwright install chromium') }
    const cache = process.platform === 'darwin' ? path.join(process.env.HOME, 'Library/Caches/ms-playwright') : path.join(process.env.HOME, '.cache/ms-playwright')
    if (fs.existsSync(cache) && fs.readdirSync(cache).some((d) => /^chromium/.test(d))) ok('chromium installed', cache)
    else bad('no Playwright chromium', 'cd graph && npx playwright install chromium')
  }
  try { await exec('ffmpeg', ['-version'], { timeout: 5_000 }); ok('ffmpeg', 'GIF walkthroughs will be produced') } catch { nag('ffmpeg not found — video is kept as .webm, no GIF in the PR', 'brew install ffmpeg') }
  if (!process.env.PAG_APP_EMAIL || !process.env.PAG_APP_PASSWORD) {
    nag('no app login (PAG_APP_EMAIL / PAG_APP_PASSWORD) — witness limited to pages reachable WITHOUT auth: /login, /signup, /forgot-password',
        'set them once you have an account on the backend web-app/.env points at; tickets behind the login then get screenshots too')
  } else ok(`app login ${process.env.PAG_APP_EMAIL}`, `app ${process.env.PAG_APP_URL || 'http://localhost:3000 (started per run)'}`)
}

console.log('\n\x1b[1mCONTEXT TREE\x1b[0m')
const par = process.env.PAG_PAR_DIR || path.resolve(import.meta.dirname, '../../.par')
for (const [f, label] of [['index.json', 'repo index'], ['history.json', 'ticket→file history'], ['tickets.json', 'real ticket text']]) {
  const p = path.join(par, f)
  if (!fs.existsSync(p)) { bad(`${label} missing (${f})`, `cd .. && node src/cli.mjs ${f === 'index.json' ? 'index --repo ~/pioneer' : f === 'history.json' ? 'mine --repo ~/pioneer --since 2024-06-01' : 'fetch'}`); continue }
  const st = fs.statSync(p)
  const ageH = (Date.now() - st.mtimeMs) / 3.6e6
  const d = JSON.parse(fs.readFileSync(p, 'utf8'))
  const n = Array.isArray(d) ? d.length : (d.files?.length ?? Object.keys(d).length)
  const msg = `${n} entries · ${(st.size / 1e6).toFixed(1)}MB · ${ageH < 24 ? `${ageH.toFixed(0)}h old` : `${(ageH / 24).toFixed(0)}d old`}`
  if (ageH > 24 * 7) nag(`${label} is stale`, 'node bin/refresh-index.mjs --repo ~/pioneer --base main')
  else ok(label, msg)
}
console.log(`${OK} candidate width  \x1b[2mk=${process.env.PAG_CANDIDATE_K || 50} (any-hit@50 61.5% vs @25 49.8% — measured)\x1b[0m`)

console.log('\n\x1b[1mWORKTREE + BASELINE\x1b[0m')
if (!repo) {
  nag('--repo not given, skipping worktree and baseline checks')
} else if (!fs.existsSync(path.join(repo, '.git'))) {
  bad(`${repo} is not a git worktree`, `git -C ~/pioneer worktree add -b bug/pag-smoke ${repo} origin/${base}`)
} else {
  try {
    const { stdout: top } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: repo })
    const { stdout: common } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: repo })
    if (path.resolve(repo, common.trim()) === path.resolve(top.trim(), '.git')) {
      bad(`${repo} is the PRIMARY worktree — the agent would edit your own checkout`, `git -C ~/pioneer worktree add -b bug/pag-smoke ~/pioneer-agent origin/${base}`)
    } else ok('linked worktree', repo)

    // A worktree without node_modules cannot run nx, and the failure mode is a silent zero
    // baseline — so this is checked before anything that depends on it.
    if (!fs.existsSync(path.join(repo, 'node_modules', '.bin', 'nx'))) {
      bad('worktree has no node_modules — nx cannot run, and baseline.mjs would record 0 failures',
          `node bin/prepare-worktree.mjs --repo ${repo} --from ~/pioneer`)
    } else ok('node_modules resolvable in the worktree')

    const { stdout: dirty } = await exec('git', ['status', '--porcelain'], { cwd: repo })
    if (dirty.trim()) nag(`worktree has ${dirty.trim().split('\n').length} uncommitted change(s)`, 'the agent expects a clean tree; git checkout -- . or use a fresh worktree')
    else ok('worktree clean')

    await exec('git', ['fetch', 'origin', base, '--quiet'], { cwd: repo, maxBuffer: 1 << 26 })
    const { stdout: head } = await exec('git', ['rev-parse', `origin/${base}`], { cwd: repo })
    const live = head.trim()
    const pin = snap.readPin()

    if (!pin) {
      bad('no prepared snapshot — runs pin to a commit the refresher prepares',
          `node bin/refresh.mjs --repo ~/pioneer-refresh --base ${base}`)
    } else if (pin.base !== base) {
      bad(`snapshot is for base "${pin.base}", you asked for "${base}"`, `node bin/refresh.mjs --repo ~/pioneer-refresh --base ${base}`)
    } else {
      const age = snap.pinAgeHours()
      const behind = pin.sha === live ? 'current' : 'behind live HEAD'
      const detail = `${pin.projects} project baseline(s) · ${age < 1 ? `${(age * 60).toFixed(0)}m` : `${age.toFixed(1)}h`} old · ${behind}`
      if (age > 24) nag(`snapshot ${pin.sha.slice(0, 7)} is stale`, 'is the refresher running?  launchctl list | grep panda-agent')
      else ok(`snapshot pinned at ${base}@${pin.sha.slice(0, 7)}`, detail)
      // Being behind live HEAD is the DESIGN, not a problem — say so, so nobody "fixes" it.
      if (pin.sha !== live) console.log(`      \x1b[2mruns branch from the pin, not from ${live.slice(0, 7)} — that is intentional\x1b[0m`)
    }
  } catch (e) {
    bad(`worktree check failed: ${String(e.message).slice(0, 120)}`)
  }
}

console.log('')
if (fatal) {
  console.log(`\x1b[31m${fatal} blocker(s)\x1b[0m${warn ? ` and \x1b[33m${warn} warning(s)\x1b[0m` : ''} — fix the blockers before spending.\n`)
  process.exit(1)
}
console.log(`\x1b[32mready\x1b[0m${warn ? ` with \x1b[33m${warn} warning(s)\x1b[0m` : ''} — next: node bin/run.mjs <KEY> --repo ${repo || '<worktree>'} --base ${base} --dry-run\n`)
