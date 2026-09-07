#!/usr/bin/env node
// Point the app the agent starts (and QA screenshots) at a LIVE backend.
//
//   npm run backend            → qa, released by "Shared Account" — the company's backend; the agent
//                                cannot deploy there, so backend fixes are QA'd in OBSERVE mode
//   npm run backend -- agent   → the agent's own version in your AWS account — deploys land here,
//                                so backend fixes are QA'd in VERIFY mode (needs `aws sso login`)
//   npm run backend -- demo    → any other branch name in the registry
//
// The web-app .env files committed in pioneer are stale on every branch (main names a deleted
// AppSync API, qa a deleted Cognito client). The app's Env Switcher ignores them and reads
// https://preview.api.developerpanda.org instead; so do we. The values land in graph/.env as
// VITE_APP_AWS_* lines, which `npm run app` and the QA run pass to the Vite dev server, where
// process.env beats .env. The deploy phase reads the same lines to know whether it may deploy.
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_VERSION_ID, REGISTRY, registryEntries } from '../src/nodes/deploy.mjs'

const envPath = path.join(path.dirname(import.meta.dirname), '.env')

/** The `# backend:` line `pointAt` wrote last time → { branch, developer } or null. */
export function currentChoice() {
  const line = (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '').split('\n').find((l) => l.startsWith('# backend:'))
  const m = line && /^# backend: (\S+) released by (.+?), version /.exec(line)
  return m ? { branch: m[1], developer: m[2] } : null
}

/** Write the registry's current values for a backend into graph/.env. Returns the entry, or throws with a one-line reason. */
export async function pointAt(branch = 'qa', developer) {
  developer = developer || (branch === 'qa' ? 'Shared Account' : branch === 'demo' ? 'Demo' : null)
  const apis = await registryEntries()
  if (!apis) throw new Error(`could not read ${REGISTRY}`)
  const api = branch === 'agent'
    ? apis.find((a) => a.versionId === AGENT_VERSION_ID)
    : apis.find((a) => a.branch === branch && (!developer || a.developer === developer)) || apis.find((a) => a.branch === branch)
  if (!api) {
    if (branch === 'agent') throw new Error(`the agent backend (version ${AGENT_VERSION_ID}) is not in ${REGISTRY} — it is published by the deploy phase's version:upsert; run a ticket with a backend change first`)
    throw new Error(`no "${branch}" backend in ${REGISTRY}. Branches there: ${[...new Set(apis.map((a) => a.branch))].slice(0, 25).join(', ')}`)
  }
  const vars = {
    VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT: api.url,
    VITE_APP_AWS_APPSYNC_API_KEY: api.apiKey,
    VITE_APP_AWS_DOMAIN_API_KEY: api.domainKey,
    VITE_APP_AWS_COGNITO_USER_POOL_ID: api.userPoolId,
    VITE_APP_AWS_COGNITO_USER_POOL_WEB_CLIENT_ID: api.userPoolWebClientId,
    VITE_APP_AWS_COGNITO_REGION: api.region || 'us-east-1',
  }
  const kept = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n').filter((l) => !/^(VITE_APP_AWS_|# backend:)/.test(l)) : []
  while (kept.length && kept.at(-1) === '') kept.pop()
  const own = api.versionId === AGENT_VERSION_ID
  const block = [`# backend: ${api.branch} released by ${api.developer}, version ${api.versionId}${own ? ' (the agent backend — deploys land here)' : ' (shared — no deploys; backend fixes are QA\'d in observe mode)'}, from ${REGISTRY} on ${new Date().toISOString().slice(0, 10)} — rerun \`npm run backend\` if it is redeployed`,
    ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)]
  fs.writeFileSync(envPath, [...kept, '', ...block, ''].join('\n'), { mode: 0o600 })
  for (const [k, v] of Object.entries(vars)) process.env[k] = v   // the process that called us sees the new backend too
  return { ...api, own, changed: kept.length !== 0 }
}

export const describe = (api) => `${api.branch} (released by ${api.developer}, version ${api.versionId}${api.own ? ' — the agent backend' : ' — shared, no deploys from here'})\n  api   ${api.url}\n  pool  ${api.userPoolId}  client ${api.userPoolWebClientId}`

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const api = await pointAt(process.argv[2] || 'qa', process.argv[3])
    console.log(`${describe(api)}\n  written to ${envPath}`)
  } catch (e) { console.error(e.message); process.exit(1) }
}
