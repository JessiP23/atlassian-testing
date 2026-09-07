#!/usr/bin/env node
// Run the web app locally against the backend graph/.env points at — the same one the agent's QA
// screenshots use. One command, same every day:
//
//   npm run app
//
// Needs no AWS session: the VITE_APP_AWS_* lines `npm run backend` wrote into graph/.env are passed
// to the Vite dev server in the worktree (process env beats the committed .env files). Sign in at
// http://localhost:3000 with PAG_APP_EMAIL / PAG_APP_PASSWORD from graph/.env. Ctrl-C stops it.
import '../src/lib/boot.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repo = process.env.PAG_WORKTREE || path.join(os.homedir(), 'pioneer-agent')
const envPath = path.join(path.dirname(import.meta.dirname), '.env')
const die = (m) => { console.error(`  ${m}`); process.exit(1) }

if (!fs.existsSync(repo)) die(`${repo} does not exist — run \`npm run wt\` first`)
if (!process.env.VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT || !process.env.VITE_APP_AWS_COGNITO_USER_POOL_ID) die('graph/.env has no backend — run `npm run backend` (company qa) or `npm run backend agent` first')
const which = (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '').split('\n').find((l) => l.startsWith('# backend:'))?.replace(/^# backend: /, '').replace(/, from .*$/, '') || 'from graph/.env'
console.error(`  backend ${which}\n  api     ${process.env.VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT}\n  pool    ${process.env.VITE_APP_AWS_COGNITO_USER_POOL_ID}`)
console.error(`  sign in at http://localhost:3000 as ${process.env.PAG_APP_EMAIL || '<PAG_APP_EMAIL>'} (password: PAG_APP_PASSWORD in graph/.env)\n`)

// Anything still listening on :3000 (a server a previous run left behind) and the shared Vite cache
// it may have corrupted both go first — see the note in src/lib/app.mjs.
await exec('bash', ['-c', 'lsof -ti :3000 | xargs kill -9 2>/dev/null; true']).catch(() => {})
fs.rmSync(path.join(repo, 'node_modules', '.vite'), { recursive: true, force: true })
const child = spawn('npx', ['nx', 'run', 'clients-web-app:serve:development', '--port=3000', '--host=127.0.0.1'], {
  cwd: repo, stdio: 'inherit', env: { ...process.env, VITE_APP_AWS_COGNITO_REGION: process.env.VITE_APP_AWS_COGNITO_REGION || 'us-east-1', BROWSER: 'none' },
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0) })
child.on('exit', (code) => process.exit(code ?? 0))
