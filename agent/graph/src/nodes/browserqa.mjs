// Browser QA — verify the fix on the RUNNING app, with eyes, after the gate is green.
//
// WHY THIS SHAPE. Four runs of ESI2-3406 tried the other one: write a Playwright spec that is red
// BEFORE the fix, freeze it, prove it green after. For a lambda that is exact rigor and it stays
// (see reproduce.mjs). For a screen in a 6,900-file app it asked a model that could not see the
// page to author a working flow in 210 seconds before anyone had fixed anything. Zero screenshots
// in four attempts, and a correct patch shipped twice as INCOMPLETE because the run was hostage to
// a spec no patch could turn green.
//
// Cody's panda-code-agent gets its UI evidence the other way round, and it works: fix first, then
// reproduce the ticket's steps on the fixed app in a real browser, screenshot each state, and let
// the REPORTER's screenshot be the before. Its browser step has 75 minutes and eyes
// (`mcp__playwright__browser_snapshot`). This node is that step, on our budget: Playwright MCP,
// signed in from the baked state, ~20 minutes, and permission to CREATE the role or user the ticket
// names — a permissions bug is invisible to the admin account we hold, and Cody's prompt says
// "set up whatever data the repro needs" for exactly this reason.
//
// It never blocks the PR. Its verdict and screenshots go into the body; a QA that could not confirm
// the fix says so at the top of the PR instead of failing the run.
import fs from 'node:fs'
import path from 'node:path'
import { tierFor } from '../lib/models.mjs'
import { runClaude } from '../lib/agent.mjs'
import { ensureApp } from '../lib/app.mjs'
import { collectShots, saveEvidence } from '../lib/repro.mjs'
import { loadProfile } from '../../profiles/index.mjs'
import * as browsermcp from '../lib/browsermcp.mjs'

const UI_EVIDENCE = process.env.PAG_UI_EVIDENCE === '1'
const QA_BUDGET_USD = Number(process.env.PAG_QA_BUDGET || 4)
const real = (v) => { const x = String(v ?? '').trim(); return x && !/[<>]/.test(x) && !/^(your|todo|changeme|xxx)/i.test(x) ? x : '' }
const HAS_LOGIN = () => Boolean(real(process.env.PAG_APP_EMAIL) && real(process.env.PAG_APP_PASSWORD))

/** The app's own route table, from the index. $0. A goto to a real route beats hunting a nav. */
function appRoutes(profile) {
  try {
    const par = process.env.PAG_PAR_DIR || path.resolve(import.meta.dirname, '../../../.par')
    const idx = JSON.parse(fs.readFileSync(path.join(par, 'index.json'), 'utf8'))
    return [...new Set((idx.files || [])
      .filter((f) => profile.isUi?.(f.path) && (f.routes || []).length)
      .flatMap((f) => f.routes).filter((r) => typeof r === 'string' && r.startsWith('/')))].sort()
  } catch { return [] }
}

const PROMPT = (s, { appUrl, outDir, resultFile, ticketShots, routes, minutes }) => `You are doing BROWSER QA for ${s.issueKey}: confirm, in a real browser, that the bug the ticket reports
is gone on the FIXED app, and capture screenshots that prove it. The fix is already applied and the local
dev server at ${appUrl} is serving it (Vite HMR — the code you see running is the patched code). You are NOT
writing tests and you do NOT edit code.

## Your tools
\`browser_navigate\`, \`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_select_option\`,
\`browser_take_screenshot\`, \`browser_wait_for\`, \`browser_console_messages\`. If a name is missing, list the
\`mcp__playwright__*\` tools you actually have and use the closest one. The browser is ALREADY SIGNED IN as
${process.env.PAG_APP_EMAIL} — do not sign in again.
Drive by SNAPSHOT, not by pixels: \`browser_snapshot\` gives you the live accessibility tree (real roles and
names). Snapshot before you click, snapshot after to confirm the state changed. A SPA action resolves
asynchronously — \`browser_wait_for\` the expected text instead of assuming it worked.
If \`browser_start_video\` / \`browser_start_tracing\` exist, call them FIRST and stop them LAST.

## The ticket
${s.spec.summary}
${s.spec.symptom?.screen ? `
Symptom appears on: ${s.spec.symptom.screen}
Error text: ${s.spec.symptom.errorText || '(none — a wrong value or a missing element)'}
Values involved: ${(s.spec.symptom.inputs || []).join(', ') || '(none given)'}` : ''}

Acceptance criteria (what "fixed" means):
${(s.spec.acceptanceCriteria || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}

Steps to reproduce, from the ticket:
${(s.ticket?.description || '').slice(0, 3000)}
${ticketShots.length ? `
## The reporter's screenshots — LOOK at them first
${ticketShots.map((t) => `- ${t}`).join('\n')}
\`Read\` each one. They show the exact screen, the exact control, and often the exact data (record id, role
name, field config). That is where you are going and what "fixed" has to look like.` : ''}

## What was changed (from the patch step)
Files: ${(s.changed || []).join(', ')}
${String((s.plan?.steps || []).join(' ')).slice(0, 1500)}
${routes.length ? `
## This app's real routes — navigate, do not hunt
${routes.map((r) => `    ${r}`).join('\n')}` : ''}

## Outcome file — write it FIRST, keep it current
Write ${resultFile} NOW, before opening the browser, and update it after every step. A hard timeout can end
this session at any moment; the file must be true at every moment:
\`\`\`json
{ "status": "incomplete",
  "summary": "one paragraph: is the reported bug confirmed gone; what else you checked; what is still wrong",
  "steps": [ { "file": "01-slug.png", "caption": "what this screenshot shows, in the ticket's words" } ],
  "unresolvedIssues": [ { "issue": "...", "impact": "...", "nextStep": "..." } ] }
\`\`\`
\`status\`: \`passed\` (bug confirmed gone, nothing else broken) · \`bugs_unresolved\` (the bug, or a regression,
is still visible) · \`incomplete\` (you did not finish). Never leave a stale optimistic status.

## Data setup — you are allowed to create what the ticket needs
The account you hold is an admin. If the ticket is about a ROLE, a PERMISSION, a specific FIELD CONFIGURATION or
a record that this account does not have: create it. Create a custom role with exactly the permissions the
ticket names, create or invite a user with that role (any name; use a +tag on the QA email), configure the field
as the ticket describes, create a record with the ticket's values. Then sign out and sign in AS THAT USER to
reproduce — the bug may be invisible to an admin (ESI2-3406 is). Never delete anything, never change an existing
user's role, never touch account or organisation settings beyond what the ticket needs.

## Do this, in order
1. Write the outcome file.
2. Navigate to the screen the ticket names, by route where you can. Snapshot. If data setup is needed, do it
   now and sign in as the right user.
3. Follow the ticket's steps exactly. At each state the ticket describes, \`browser_take_screenshot\` with
   filename \`NN-slug.png\` (01, 02, …) and add it to \`steps\` with a caption in the ticket's words. Let the
   page settle first — no spinners mid-frame, scroll the relevant UI into view, dismiss stale toasts.
4. The last screenshot must show the acceptance criterion satisfied — or NOT satisfied, honestly.
5. Check the immediately surrounding behaviour once (same screen, adjacent action) so a regression is caught.
6. Set the final \`status\` and \`summary\`. Stop video/tracing if you started them.

## Budget
About ${minutes} minutes. Aim for 3–8 screenshots. If the screen cannot be reached (missing data you cannot
create, an error page), take a screenshot of where you got stuck, record it in \`unresolvedIssues\`, set
\`status\` honestly, and stop. A truthful partial beats a heroic timeout.

Do NOT edit any file under ${s.repo}. Do NOT run git. Do NOT sign out of the admin account until your
setup is done.`

export function browserQaNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const skip = (reason) => { onProgress(`browser QA skipped: ${reason}`); return { qa: { status: 'skipped', reason } } }
    if (!UI_EVIDENCE) return skip('PAG_UI_EVIDENCE is not 1')
    if (!s.gate?.ok) return skip('the gate is not green')
    const profile = loadProfile(s.repo)
    if (!(s.changed || []).some((f) => profile.isUi?.(f))) return skip('the fix is not in the web app — the local dev server would not run it')
    if (!HAS_LOGIN()) return skip('PAG_APP_EMAIL / PAG_APP_PASSWORD are not set to a real account')
    if (!browsermcp.mcpEnabled()) return skip('PAG_WITNESS_MCP=0')

    const timeMs = budget.timeFor('browserqa')
    if (timeMs < 180_000) return skip(`${(timeMs / 1000).toFixed(0)}s left on the run — not enough to sign in and walk the ticket`)

    const app = await ensureApp({ repo: s.repo, onProgress })
    if (!app) return skip('the web app could not be started')

    const statePath = await browsermcp.loginState({ appUrl: app.url, onProgress })
    if (!statePath) return skip('could not sign in to bake a browser state — check the credentials against the app')
    // ABSOLUTE. PAG_RUN_DIR is relative to the graph dir, but the model's cwd is the product
    // worktree — a relative path here would make it write qa-result.json INTO pioneer.
    const runDir = path.resolve(process.env.PAG_RUN_DIR)
    const outDir = path.join(runDir, 'qa')
    fs.mkdirSync(outDir, { recursive: true })
    const mcpConfig = browsermcp.writeConfig({ statePath, outDir })
    if (!mcpConfig) return skip('could not write the browser config')

    const resultFile = path.join(outDir, 'qa-result.json')
    const ticketShots = (s.ticketShots || []).map((t) => path.join(runDir, 'evidence', t.file))
    const tier = tierFor('repro')
    const minutes = Math.floor(timeMs / 60_000)
    onProgress(`browser QA: ${minutes} min, signed in as ${process.env.PAG_APP_EMAIL}, ${ticketShots.length} ticket screenshot(s) to read`)

    const r = await runClaude({
      cwd: s.repo, model: tier.model, budgetUsd: Math.min(QA_BUDGET_USD, budget.availableFor('repro')), timeoutMs: timeMs,
      onProgress, mcpConfig,
      prompt: PROMPT(s, { appUrl: app.url, outDir, resultFile, ticketShots, routes: appRoutes(profile), minutes }),
    })
    budget.charge('qa', r.cost, { model: tier.model, subtype: r.subtype, exit: r.code })

    // Whatever the session managed, collect it. The outcome file is the model's word; the PNGs on
    // disk are the evidence. A screenshot the file does not caption still ships, uncaptioned.
    let result = {}
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { /* none written */ }
    const got = await collectShots(outDir, 'after')
    const captions = new Map((result.steps || []).map((x) => [String(x.file || '').replace(/^.*\//, ''), x.caption]))
    const shots = got.shots.map((f) => {
      const base = path.basename(f)
      const original = base.replace(/^after-(\d\d-)?/, (_, n) => n || '')
      return { file: base, caption: captions.get(base) || captions.get(original) || null }
    })
    saveEvidence('qa-result.json', JSON.stringify(result, null, 2))
    const status = result.status || (r.timedOut ? 'incomplete' : shots.length ? 'incomplete' : 'no_output')
    onProgress(`browser QA: ${status} — ${shots.length} screenshot(s), video ${got.video ? 'yes' : 'no'}, trace ${got.trace ? 'yes' : 'no'}`)
    return {
      qa: {
        status, summary: result.summary || '', unresolved: result.unresolvedIssues || [],
        shots, video: got.video && path.basename(got.video), gif: got.gif && path.basename(got.gif), trace: got.trace && path.basename(got.trace),
        appUrl: app.url, user: process.env.PAG_APP_EMAIL, cost: r.cost,
      },
    }
  }
}
