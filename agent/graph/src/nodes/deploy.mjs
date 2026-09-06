// Deploy the run's own patch to a PRIVATE backend, so browser QA can show a backend fix WORKING.
//
// The local dev server only serves the frontend; every automation, permission check and record write
// runs on whatever AppSync it points at. Until this node existed that was qa — which runs qa's code —
// so a Lambda fix could never appear on a screen and the PR said "backend fix, no screenshots". Cody's
// pipeline deploys a per-branch backend first (`deploy:version`) and QA's against it; this is the same
// shape, built on pioneer's own scripts and proven by hand on ESI2-3194 before it was automated:
//
//   aws configure export-credentials    (the SSO session; both AWS SDKs then agree)
//   <product>/.env.local                (hosted zone, account — the deploy env developers export)
//   AP_VERSION_ID = md5(agent/<KEY>-fix)[0:8]  — ONE backend per TICKET, reused across runs and -rN branches:
//                                        the 32-minute stack build happens once, later runs push Lambdas
//   deploy:version:infra   only when the ticket's stacks do not exist yet
//   nx affected deploy:version (lambdas)  only the functions this patch touches, five at a time
//   version:upsert          registers it in the switcher registry (the app's Env Switcher sees it)
//   env.sh                  resolves the version's AppSync/Cognito; the app is restarted against them
//   setup-qa-org.sh         Cody's seed, unmodified, fetched from origin/panda-code-agent — only when the
//                           version's Cognito pool has no QA admin yet (fresh pool is empty)
//
// Its clock is excluded from the run deadline: a deploy is a build, not model time, and a 30-minute
// stack creation must not eat the minutes the patch needed. Every failure is a reason, never a throw:
// QA falls back to observe mode and the PR says the fix was not deployed. Nothing here touches git in
// the worktree except a deploy-time-only edit for one known pioneer bug, reverted in `finally`.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadProfile } from '../../profiles/index.mjs'
import { isTestFile } from '../lib/guard.mjs'
import { stopApp } from '../lib/app.mjs'
import { resetLoginState } from '../lib/browsermcp.mjs'
import { saveEvidence } from '../lib/repro.mjs'

const exec = promisify(execFile)
const GRAPH_DIR = path.resolve(import.meta.dirname, '../..')
const UI_EVIDENCE = process.env.PAG_UI_EVIDENCE === '1'

const INFRA_MAX_MS = 60 * 60_000
const LAMBDAS_MAX_MS = 40 * 60_000
const STEP_MAX_MS = 10 * 60_000
// Cody's runbook: deploy:version failures that must not strand a deploy — seven deprecated AI
// processors whose target is an intentional skip, and register-device-token (created only outside dev).
const BENIGN = new Set(['lambdas-fns-collection-filter-ai-processor', 'lambdas-fns-ai-attachments-ocr-processor',
  'lambdas-fns-chat-collection-filter-ai', 'lambdas-fns-automations-ai-processor', 'lambdas-fns-chat-automations-ai',
  'lambdas-fns-forms-ai-processor', 'lambdas-fns-chat-forms-ai', 'lambdas-fns-register-device-token'])

// ONE agent backend, for every ticket. It started life as the per-ticket version for ESI2-3194
// (md5 of "agent/ESI2-3194-fix", built and seeded by hand on 2026-09-06) and is kept as THE agent
// backend on purpose: the QA org's collections, records and automations persist across tickets, so
// a scenario built once — by the agent or by hand — is there for the next ticket that touches the
// same feature. Each run only pushes its own Lambdas onto it (minutes). Cost: two runs at once would
// overwrite each other's Lambdas, which this pipeline never does. Changing this id means a new
// 30-minute stack build and an empty org — do it deliberately, never for a ticket.
export const AGENT_VERSION_ID = '238f0e42'
export const versionIdFor = () => AGENT_VERSION_ID

/** KEY=value lines → object. Comments and blanks skipped; values never logged by callers. */
export function parseDotenv(text) {
  const out = {}
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

export const STATIC_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN']
/** process.env without the static keys graph/.env supplies — the deploy must not run as the bot user. */
export function envWithoutStaticKeys() {
  const e = { ...process.env }
  for (const k of STATIC_KEYS) delete e[k]
  if (e.PAG_SHELL_AWS_PROFILE) e.AWS_PROFILE = e.PAG_SHELL_AWS_PROFILE
  return e
}

/**
 * The developer's SSO credentials, as static env values both AWS SDKs honour first. Resolved from the
 * SHELL's profile (boot.mjs saves it as PAG_SHELL_AWS_PROFILE) with the file's keys removed — the first
 * run resolved `export-credentials` on top of graph/.env and got the bot user `panda-code-agent`, whose
 * policy allows Bedrock and nothing else: describe-stacks denied → "no stacks" → a doomed infra build.
 */
export async function exportCredentials() {
  try {
    const args = ['configure', 'export-credentials', '--format', 'env']
    if (process.env.PAG_SHELL_AWS_PROFILE) args.push('--profile', process.env.PAG_SHELL_AWS_PROFILE)
    const { stdout } = await exec('aws', args, { env: envWithoutStaticKeys(), timeout: 30_000 })
    const creds = parseDotenv(stdout)
    if (!creds.AWS_ACCESS_KEY_ID) return null
    const { stdout: who } = await exec('aws', ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'], { env: { ...envWithoutStaticKeys(), ...creds }, timeout: 30_000 })
    return { ...creds, arn: who.trim() }
  } catch { return null }
}

/** Run a build step: streamed tail kept for the log, a heartbeat every minute, a hard cap. */
function runStep(cmd, args, { cwd, env, maxMs, label, onProgress, log }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (d) => { const s = String(d); tail = (tail + s).slice(-60_000); log.push(s) }
    child.stdout.on('data', keep); child.stderr.on('data', keep)
    const beat = setInterval(() => onProgress(`deploy: ${label} … ${((Date.now() - t0) / 60_000).toFixed(0)} min`), 60_000)
    const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* gone */ } }, maxMs)
    child.on('exit', (code) => {
      clearInterval(beat); clearTimeout(timer)
      resolve({ code, tail, ms: Date.now() - t0, timedOut: Date.now() - t0 >= maxMs })
    })
    child.on('error', (e) => { clearInterval(beat); clearTimeout(timer); resolve({ code: -1, tail: String(e.message), ms: Date.now() - t0 }) })
  })
}

/** nx prints "Failed tasks:\n- project:target" — the projects that failed. */
export function failedProjects(out) {
  const m = String(out).match(/Failed tasks:\s*\n((?:\s*-\s*\S+.*\n?)+)/)
  if (!m) return []
  return [...new Set([...m[1].matchAll(/-\s*([A-Za-z0-9_-]+):/g)].map((x) => x[1]))]
}

async function stackExists(name, env) {
  try { await exec('aws', ['cloudformation', 'describe-stacks', '--stack-name', name], { env, timeout: 30_000 }); return true } catch { return false }
}

// One known pioneer bug for versioned deploys (a PR to main is the real fix): services-secondary creates
// the SES identity `mailer.<zone>` unconditionally and collides with the base stack's. Deploy-time-only
// edit, same pattern resources/ses.ts already uses; reverted by the caller.
const SES_FILE = 'packages/infra/services-secondary/src/modules/inbound-email-processor/inbound-email-shared-resources.ts'
function applySesPreviewGuard(repo) {
  const p = path.join(repo, SES_FILE)
  if (!fs.existsSync(p)) return false
  let s = fs.readFileSync(p, 'utf8')
  if (!s.includes("new ses.EmailIdentity(this, 'mailer-domain-identity', {")) return false // already fixed upstream
  s = s.replace("import { isProd, named } from '@/infra/libs/util'", "import { isPreview, isProd, named } from '@/infra/libs/util'")
    .replace('public readonly mailerDomainIdentity: ses.EmailIdentity', 'public readonly mailerDomainIdentity: ses.IEmailIdentity')
    .replace(/    this\.mailerDomainIdentity = new ses\.EmailIdentity\(this, 'mailer-domain-identity', \{\n      identity: ses\.Identity\.domain\(this\.mailerDomain\),\n    \}\)\n/,
      "    this.mailerDomainIdentity = isPreview\n      ? ses.EmailIdentity.fromEmailIdentityName(this, 'mailer-domain-identity', this.mailerDomain)\n      : new ses.EmailIdentity(this, 'mailer-domain-identity', { identity: ses.Identity.domain(this.mailerDomain) })\n    if (isPreview) return\n")
    .replace('    this.mailerDomainIdentity.dkimRecords.forEach((record, index) => {', '    ;(this.mailerDomainIdentity as ses.EmailIdentity).dkimRecords.forEach((record, index) => {')
  fs.writeFileSync(p, s)
  return true
}

export function deployNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const skip = (reason) => { onProgress(`deploy skipped: ${reason}`); return { backend: { status: 'skipped', reason } } }
    if (!UI_EVIDENCE) return skip('PAG_UI_EVIDENCE is not 1 — a deploy only exists to feed browser QA')
    if (!s.gate?.ok) return skip('the gate is not green')
    const profile = loadProfile(s.repo)
    const backend = (s.changed || []).filter((f) => !profile.isUi?.(f) && !isTestFile(f) && /^packages\/(lambdas|libs|apis|shared)\//.test(f))
    if (!backend.length) return skip('no backend files changed — the dev server already runs the fix')

    // The product checkout the worktree was made from holds the deploy env developers export by hand.
    let productDir
    try { productDir = path.dirname(path.resolve(s.repo, (await exec('git', ['rev-parse', '--git-common-dir'], { cwd: s.repo })).stdout.trim())) } catch { productDir = null }
    const envLocal = productDir && path.join(productDir, '.env.local')
    if (!envLocal || !fs.existsSync(envLocal)) return skip(`no .env.local in the product checkout (${productDir || '?'}) — the deploy env (hosted zone, account id) lives there`)
    const creds = await exportCredentials()
    if (!creds) return skip(`no AWS credentials from the SSO session (profile ${process.env.PAG_SHELL_AWS_PROFILE || 'default'}) — run \`aws sso login\` before the run`)
    if (/:user\/panda-code-agent$/.test(creds.arn)) return skip(`the resolved identity is the bot user (${creds.arn}) — the deploy needs your SSO role; run \`aws sso login\` and set AWS_PROFILE in the shell`)
    const { arn, ...credEnv } = creds
    onProgress(`deploy: as ${arn}`)

    const versionId = versionIdFor(s.issueKey)
    const env = {
      ...envWithoutStaticKeys(), ...parseDotenv(fs.readFileSync(envLocal, 'utf8')), ...credEnv,
      AWS_ENV: 'dev', AP_VERSION_ID: versionId, BRANCH_NAME: s.branchName || `agent/${s.issueKey}-fix`,
      CDK_DISABLE_NOTICES: '1', FORCE_COLOR: '0', NX_DAEMON: 'false',
    }
    const log = []
    const t0 = Date.now()
    const fail = (step, why, tail = '') => {
      saveEvidence('deploy.log', log.join(''))
      onProgress(`deploy failed at ${step}: ${why}`)
      budget.exclude(Date.now() - t0)
      return { backend: { status: 'failed', step, reason: why, tail: String(tail).slice(-2500), versionId } }
    }

    onProgress(`deploy: backend version ${versionId} for ${s.issueKey} (${backend.length} backend file(s) changed)`)

    // ---- 1. stacks, first time only ----------------------------------------------------------------
    const haveStacks = (await stackExists(`ap-dev-${versionId}-appsync`, env)) && (await stackExists(`ap-dev-${versionId}-services-secondary`, env))
    let builtInfra = false
    if (!haveStacks) {
      onProgress(`deploy: no stacks for ${versionId} yet — creating the agent backend (30–40 min, once ever)`)
      const patched = applySesPreviewGuard(s.repo)
      let r
      try {
        r = await runStep('npm', ['run', 'deploy:version:infra'], { cwd: s.repo, env, maxMs: INFRA_MAX_MS, label: 'creating stacks', onProgress, log })
      } finally {
        if (patched) await exec('git', ['checkout', '--', SES_FILE], { cwd: s.repo }).catch(() => {})
      }
      if (r.code !== 0) return fail('infra', r.timedOut ? `stack creation exceeded ${INFRA_MAX_MS / 60_000} min` : `deploy:version:infra exited ${r.code}`, r.tail)
      builtInfra = true
    }

    // ---- 2. the Lambdas this patch touches ---------------------------------------------------------
    // Two steps, not `nx affected --projects`: in nx 19 that flag is not a filter on `affected`, it is
    // forwarded to every task, so each lambda.sh got `--projects tag:type:lambda` and died with
    // "Unsupported flag" (run r4). `show projects --affected --projects <tag>` IS a filter.
    const list = await runStep('npx', ['nx', 'show', 'projects', '--affected', '--base', s.baseSha, '--projects', 'tag:type:lambda', '--sep', ','],
      { cwd: s.repo, env, maxMs: 180_000, label: 'listing affected Lambdas', onProgress, log: [] })
    const projects = (list.tail.trim().split('\n').pop() || '').split(',').map((x) => x.trim()).filter((x) => /^lambdas-/.test(x))
    if (list.code !== 0 || !projects.length) return fail('lambdas', list.code !== 0 ? `nx show projects exited ${list.code}` : 'nx reports no affected Lambda for this patch', list.tail)
    onProgress(`deploy: pushing ${projects.length} affected Lambda(s)`)
    const lam = await runStep('npx', ['nx', 'run-many', '--target', 'deploy:version', '--projects', projects.join(','), '--parallel', '5'],
      { cwd: s.repo, env, maxMs: LAMBDAS_MAX_MS, label: `pushing ${projects.length} Lambdas`, onProgress, log })
    const failed = failedProjects(lam.tail)
    const real = failed.filter((p) => !BENIGN.has(p))
    if (lam.code !== 0 && (real.length || !failed.length)) {
      return fail('lambdas', lam.timedOut ? `Lambda deploy exceeded ${LAMBDAS_MAX_MS / 60_000} min` : real.length ? `Lambda deploy failed for ${real.join(', ')}` : `nx affected exited ${lam.code}`, lam.tail)
    }
    const deployedCount = projects.length - failed.length

    // ---- 3. register + resolve --------------------------------------------------------------------
    const up = await runStep('npm', ['run', 'version:upsert'], { cwd: s.repo, env, maxMs: STEP_MAX_MS, label: 'registering the version', onProgress, log })
    if (up.code !== 0) onProgress(`deploy: version:upsert exited ${up.code} — continuing, the endpoints resolve without the registry`)
    const res = await runStep('bash', ['-c', '. packages/clients/web-app/scripts/env.sh >/dev/null 2>&1; env | grep "^VITE_APP_AWS_"'], { cwd: s.repo, env, maxMs: 120_000, label: 'resolving endpoints', onProgress, log: [] })
    const vite = parseDotenv(res.tail)
    if (!vite.VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT || !vite.VITE_APP_AWS_COGNITO_USER_POOL_ID) return fail('resolve', 'env.sh could not resolve the version\'s AppSync/Cognito', res.tail)

    // ---- 4. a QA org, if the pool is still empty --------------------------------------------------
    let seeded = false
    const admin = process.env.PAG_APP_EMAIL
    const hasAdmin = await exec('aws', ['cognito-idp', 'admin-get-user', '--user-pool-id', vite.VITE_APP_AWS_COGNITO_USER_POOL_ID, '--username', admin], { env, timeout: 30_000 }).then(() => true).catch(() => false)
    if (!hasAdmin) {
      onProgress(`deploy: ${admin} is not in the version's user pool — seeding a QA org (Cody's setup-qa-org.sh)`)
      const root = path.join(GRAPH_DIR, '.pag', 'deploy', versionId)   // the script's ROOT; nothing lands in the worktree
      fs.mkdirSync(path.join(root, 'panda-code-agent', 'scripts'), { recursive: true })
      fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
      let script = ''
      try { script = (await exec('git', ['show', 'origin/panda-code-agent:panda-code-agent/scripts/setup-qa-org.sh'], { cwd: s.repo, maxBuffer: 1 << 24 })).stdout } catch {
        await exec('git', ['fetch', 'origin', 'panda-code-agent'], { cwd: s.repo, timeout: 120_000 }).catch(() => {})
        script = (await exec('git', ['show', 'origin/panda-code-agent:panda-code-agent/scripts/setup-qa-org.sh'], { cwd: s.repo, maxBuffer: 1 << 24 }).catch(() => ({ stdout: '' }))).stdout
      }
      if (!script) return fail('seed', 'could not read panda-code-agent/scripts/setup-qa-org.sh from origin/panda-code-agent')
      fs.writeFileSync(path.join(root, 'panda-code-agent', 'scripts', 'setup-qa-org.sh'), script, { mode: 0o700 })
      fs.writeFileSync(path.join(root, 'panda-code-agent', 'config.json'), JSON.stringify({ deploy: { qaOrg: { adminEmail: admin, password: process.env.PAG_APP_PASSWORD, orgNamePrefix: 'PCA' } } }), { mode: 0o600 })
      fs.writeFileSync(path.join(root, 'runtime', 'deploy-info.json'), JSON.stringify({
        versionId, branch: env.BRANCH_NAME, developer: 'panda-agent', resourcePrefix: `ap-dev-${versionId}`,
        appsyncUrl: vite.VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT, apiKey: vite.VITE_APP_AWS_DOMAIN_API_KEY,
        userPoolId: vite.VITE_APP_AWS_COGNITO_USER_POOL_ID, userPoolWebClientId: vite.VITE_APP_AWS_COGNITO_USER_POOL_WEB_CLIENT_ID, region: 'us-east-1',
      }), { mode: 0o600 })
      const seed = await runStep('bash', [path.join(root, 'panda-code-agent', 'scripts', 'setup-qa-org.sh')], { cwd: root, env: { ...env, ISSUE_KEY: s.issueKey }, maxMs: STEP_MAX_MS, label: 'seeding the QA org', onProgress, log })
      const again = await exec('aws', ['cognito-idp', 'admin-get-user', '--user-pool-id', vite.VITE_APP_AWS_COGNITO_USER_POOL_ID, '--username', admin], { env, timeout: 30_000 }).then(() => true).catch(() => false)
      if (!again) return fail('seed', `setup-qa-org.sh exited ${seed.code} and ${admin} still does not exist in the pool`, seed.tail)
      seeded = true
    }

    // ---- 5. point the app at it -------------------------------------------------------------------
    // app.mjs spawns the dev server with process.env, and Vite lets process env beat the .env files.
    for (const [k, v] of Object.entries(vite)) process.env[k] = v
    process.env.VITE_APP_AWS_COGNITO_REGION = process.env.VITE_APP_AWS_COGNITO_REGION || 'us-east-1'
    stopApp()            // whatever was warmed against the old backend
    resetLoginState()    // the baked session belongs to another pool

    saveEvidence('deploy.log', log.join(''))
    const minutes = (Date.now() - t0) / 60_000
    budget.exclude(Date.now() - t0)
    onProgress(`deploy: backend ${versionId} is live — ${builtInfra ? 'stacks created, ' : ''}${deployedCount} Lambda(s) pushed${seeded ? ', QA org seeded' : ''} — ${minutes.toFixed(0)} min (not counted against the deadline)`)
    return {
      backend: {
        status: 'deployed', versionId, builtInfra, lambdas: deployedCount, seeded, minutes: Number(minutes.toFixed(1)),
        appsyncUrl: vite.VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT, userPoolId: vite.VITE_APP_AWS_COGNITO_USER_POOL_ID,
        benign: failed.filter((p) => BENIGN.has(p)),
      },
    }
  }
}
