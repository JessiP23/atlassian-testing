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

const branch = process.argv[2] || 'qa'
const developer = process.argv[3] || (branch === 'qa' ? 'Shared Account' : branch === 'demo' ? 'Demo' : null)
const envPath = path.join(path.dirname(import.meta.dirname), '.env')

const apis = await registryEntries()
if (!apis) { console.error(`could not read ${REGISTRY}`); process.exit(1) }
const api = branch === 'agent'
  ? apis.find((a) => a.versionId === AGENT_VERSION_ID)
  : apis.find((a) => a.branch === branch && (!developer || a.developer === developer)) || apis.find((a) => a.branch === branch)
if (!api) {
  if (branch === 'agent') console.error(`the agent backend (version ${AGENT_VERSION_ID}) is not in ${REGISTRY} — it is published by the deploy phase's version:upsert; run a ticket with a backend change first`)
  else console.error(`no "${branch}" backend in ${REGISTRY}. Branches there: ${[...new Set(apis.map((a) => a.branch))].slice(0, 25).join(', ')}`)
  process.exit(1)
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
console.log(`${api.branch} (released by ${api.developer}, version ${api.versionId}${own ? ' — the agent backend' : ' — shared, no deploys from here'})\n  api   ${api.url}\n  pool  ${api.userPoolId}  client ${api.userPoolWebClientId}\n  written to ${envPath}`)
