// Load graph/.env (then graph/.env.local, which wins) before anything reads process.env.
//
// Every bin/ script imports this FIRST. Without it the scripts depend on the operator having run
// `set -a; source .env; set +a` in that particular shell — which works until you open a new
// terminal, and then fails with a confusing "JIRA_URL … required" while the keys sit right there
// in the file. Config that only works in the shell you set it up in is not configured.
//
// Real environment variables always win over the file, so CI and ECS task definitions are never
// overridden by a stale local .env.

import fs from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../../../src/lib/env.mjs'

// graph/ — resolved from this file, so it works whatever directory you invoke from.
const GRAPH_DIR = path.resolve(import.meta.dirname, '../..')

export const loaded = loadEnv(GRAPH_DIR)
export const shadowed = [...(loadEnv.shadowed || [])]

// AWS_PROFILE beats static keys in the SDK's credential chain, and it is NOT in graph/.env — so it
// never shows up as "shadowed", it just silently wins. If this file supplies explicit keys, that is
// an unambiguous statement of which identity to use, so drop the profile (and any stale session
// token) for this process. Without it an expired SSO session produces
// `ExpiredTokenException ... 403` from Bedrock while perfectly good keys sit unused in the file.
//
// THE BUG THIS FIXES: the condition required AWS_PROFILE to be set before the session token was
// cleared. A shell holding a stale SSO `AWS_SESSION_TOKEN` but NO AWS_PROFILE therefore kept that
// token, and the SDK paired it with the FILE's static access key — which is not a valid identity
// at all. Bedrock answers that with AccessDeniedException, which reads exactly like a revoked
// permission or a tripped budget guardrail. And it appears the moment the SSO session expires:
// working one hour, denied the next, with nothing on the AWS side having changed.
//
// So each variable is now dropped on its own merit, whenever the file supplies static keys.
// The shell's profile is still the right identity for one thing: the backend deploy, which needs the
// developer's SSO role (CDK, SSM, Cognito), not the bot's static Bedrock keys. Remember it before it is
// dropped — nodes/deploy.mjs reads PAG_SHELL_AWS_PROFILE and never the file's keys.
if (process.env.AWS_PROFILE && !process.env.PAG_SHELL_AWS_PROFILE) process.env.PAG_SHELL_AWS_PROFILE = process.env.AWS_PROFILE

// Which identity, decided by the FILE, not by whatever the shell happens to hold:
//   graph/.env defines AWS_ACCESS_KEY_ID  → static identity (a bot user): drop the shell's profile/token.
//   graph/.env has no static keys         → the shell's SSO profile: drop the shell's static keys, which
//     are leftovers of an `aws configure export-credentials` / `set -a; . .env` and expire within the hour
//     (the doctor read that as UnrecognizedClientException the first time).
const fileHasStaticKeys = ['.env', '.env.local'].some((n) => {
  try { return /^AWS_ACCESS_KEY_ID=\S/m.test(fs.readFileSync(path.join(GRAPH_DIR, n), 'utf8')) } catch { return false }
})
// In CI the ENVIRONMENT is the source of truth (PAG_ENV_PRECEDENCE=env): the keys are Actions
// secrets placed there on purpose, and graph/.env holds only the qa backend lines — the laptop
// rule below read that as "stale shell keys" and deleted the only credentials the job had.
if (process.env.PAG_ENV_PRECEDENCE === 'env') {
  // keep everything as given
} else if (fileHasStaticKeys) {
  for (const k of ['AWS_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN']) {
    if (process.env[k]) {
      if (process.env.PAG_QUIET_ENV !== '1') console.error(`  note: ignoring ${k} from your shell — graph/.env supplies static credentials`)
      delete process.env[k]
    }
  }
} else {
  const stale = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN'].filter((k) => process.env[k])
  if (stale.length) {
    if (process.env.PAG_QUIET_ENV !== '1') console.error(`  note: ignoring ${stale.join(', ')} exported in your shell — graph/.env has no static keys; using AWS_PROFILE=${process.env.AWS_PROFILE || 'default'} (SSO)`)
    for (const k of stale) delete process.env[k]
  }
}

// Loud, once, at startup. Silent shadowing costs more time than a hard failure would.
if (shadowed.length && process.env.PAG_QUIET_ENV !== '1') {
  console.error(`\n  \x1b[2mnote: ${shadowed.length} value(s) differ between your shell and graph/.env — using the FILE: ${shadowed.join(', ')}\x1b[0m\n`)
}
