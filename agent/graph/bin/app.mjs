#!/usr/bin/env node
// Run the web app locally against THE agent backend — the one every ticket deploys to, with the QA
// org's data on it. One command, same every day:
//
//   npm run app
//
// Signs in to nothing and changes nothing: it resolves the agent backend's AppSync/Cognito with your
// SSO identity (pioneer's own env.sh), then starts the Vite dev server from the worktree with those
// values in the environment (process env beats the committed .env files). Sign in at
// http://localhost:3000 with PAG_APP_EMAIL / PAG_APP_PASSWORD from graph/.env. Ctrl-C stops it.
import '../src/lib/boot.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AGENT_VERSION_ID, exportCredentials, envWithoutStaticKeys, parseDotenv } from '../src/nodes/deploy.mjs'

const exec = promisify(execFile)
const repo = process.env.PAG_WORKTREE || path.join(os.homedir(), 'pioneer-agent')
const product = process.env.PAG_PRODUCT || path.join(os.homedir(), 'pioneer')
const envLocal = path.join(product, '.env.local')
const die = (m) => { console.error(`  ${m}`); process.exit(1) }

if (!fs.existsSync(repo)) die(`${repo} does not exist — run \`npm run wt\` first`)
if (!fs.existsSync(envLocal)) die(`${envLocal} not found — the deploy env (hosted zone, account) lives there`)
const creds = await exportCredentials()
if (!creds) die('no AWS credentials from your SSO session — run `aws sso login` first')
const { arn, ...credEnv } = creds
console.error(`  as ${arn}`)

const env = { ...envWithoutStaticKeys(), ...parseDotenv(fs.readFileSync(envLocal, 'utf8')), ...credEnv, AWS_ENV: 'dev', AP_VERSION_ID: AGENT_VERSION_ID }
const { stdout } = await exec('bash', ['-c', '. packages/clients/web-app/scripts/env.sh >/dev/null 2>&1; env | grep "^VITE_APP_AWS_"'], { cwd: repo, env, timeout: 120_000 }).catch((e) => die(`could not resolve the agent backend (${AGENT_VERSION_ID}): ${String(e.message).split('\n')[0]}`))
const vite = parseDotenv(stdout)
if (!vite.VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT) die(`env.sh returned no AppSync endpoint for ap-dev-${AGENT_VERSION_ID} — is the agent backend deployed?`)
console.error(`  backend ${AGENT_VERSION_ID}: ${vite.VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT}\n  pool    ${vite.VITE_APP_AWS_COGNITO_USER_POOL_ID}`)
console.error(`  sign in at http://localhost:3000 as ${process.env.PAG_APP_EMAIL || '<PAG_APP_EMAIL>'} (password: PAG_APP_PASSWORD in graph/.env)\n`)

// Anything still listening on :3000 (a server a previous run left behind) and the shared Vite cache
// it may have corrupted both go first — see the note in src/lib/app.mjs.
await exec('bash', ['-c', 'lsof -ti :3000 | xargs kill -9 2>/dev/null; true']).catch(() => {})
fs.rmSync(path.join(repo, 'node_modules', '.vite'), { recursive: true, force: true })
const child = spawn('npx', ['nx', 'run', 'clients-web-app:serve:development', '--port=3000', '--host=127.0.0.1'], {
  cwd: repo, stdio: 'inherit', env: { ...process.env, ...vite, VITE_APP_AWS_COGNITO_REGION: 'us-east-1', BROWSER: 'none' },
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0) })
child.on('exit', (code) => process.exit(code ?? 0))
