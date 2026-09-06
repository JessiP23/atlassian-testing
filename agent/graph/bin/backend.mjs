#!/usr/bin/env node
// Point the app the agent starts at a LIVE backend.
//
//   npm run backend            → qa, released by "Shared Account" (what the app itself defaults to)
//   npm run backend -- demo    → any other branch name in the registry
//
// The web-app .env files committed in pioneer are stale on every branch (main names a deleted
// AppSync API, qa a deleted Cognito client). The app's Env Switcher ignores them and reads
// https://preview.api.developerpanda.org instead; so do we. The values land in graph/.env as
// VITE_APP_AWS_* lines, which app.mjs passes to the Vite dev server, where process.env beats .env.
import fs from 'node:fs'
import path from 'node:path'

const REGISTRY = 'https://preview.api.developerpanda.org'
const branch = process.argv[2] || 'qa'
const developer = process.argv[3] || (branch === 'qa' ? 'Shared Account' : branch === 'demo' ? 'Demo' : null)
const envPath = path.join(path.dirname(import.meta.dirname), '.env')

const { apis } = await fetch(REGISTRY, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json())
const api = apis.find((a) => a.branch === branch && (!developer || a.developer === developer)) || apis.find((a) => a.branch === branch)
if (!api) {
  console.error(`no "${branch}" backend in ${REGISTRY}. Branches there: ${[...new Set(apis.map((a) => a.branch))].slice(0, 25).join(', ')}`)
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
const block = [`# backend: ${api.branch} released by ${api.developer}, from ${REGISTRY} on ${new Date().toISOString().slice(0, 10)} — rerun \`npm run backend\` if it is redeployed`,
  ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)]
fs.writeFileSync(envPath, [...kept, '', ...block, ''].join('\n'), { mode: 0o600 })
console.log(`${api.branch} (released by ${api.developer})\n  api   ${api.url}\n  pool  ${api.userPoolId}  client ${api.userPoolWebClientId}\n  written to ${envPath}`)
