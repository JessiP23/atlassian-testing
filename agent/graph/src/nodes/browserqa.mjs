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
const QA_BUDGET_USD = Number(process.env.PAG_QA_BUDGET || 8) // $4 bought ~6 min of Opus driving a browser: enough to verify, never to build
// Observe mode (shared backend, fix not deployed) can only capture the BEFORE state. That is context for a
// reviewer, never proof, so it gets a small, fixed slice: 3437 and 3441 spent $7–8 each building scenarios
// from scratch that could not judge anything. Verify mode (a deployed backend) keeps the full budget.
const OBSERVE_BUDGET_USD = Number(process.env.PAG_QA_OBSERVE_BUDGET || 2.5)
const OBSERVE_MINUTES = Number(process.env.PAG_QA_OBSERVE_MINUTES || 6)
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

const PROMPT = (s, { appUrl, outDir, resultFile, ticketShots, routes, minutes, mode = 'verify' }) => `${mode === 'observe' ? `You are doing BROWSER QA for ${s.issueKey} in OBSERVE mode. The fix is in the BACKEND (${(s.changed || []).filter((f) => !/test/.test(f)).slice(0, 3).join(', ')}),
which the local app at ${appUrl} does NOT run — it calls the deployed qa backend, where this fix is not deployed.
So you CANNOT see the fix, and you must not claim to. Your job: REPRODUCE the ticket on qa as it is TODAY and
record what actually happens — that is the "before" a reviewer needs next to the diff.
1. Look for the ticket's scenario by its own names first. The customer's ACCOUNT and MODULE names will never
   exist here — do not conclude anything from their absence. Search by the AUTOMATION name and FIELD names the
   ticket uses: Settings → Account management → for each module of the account you are in (start with the one
   the thread notes name, then the rest), open its Automations list and read the names; a People/Assets pair with
   the ticket's fields is the other tell. A human may have built it for you. If it exists,
   correct nothing unless it plainly differs from the ticket's configuration (screenshot before and after the
   edit), then RUN the ticket's steps end to end: make the triggering change, \`browser_wait_for\` ~10s, re-open
   the records, and screenshot the outcome — the field that should have changed, and the Activity tab showing
   who changed what. If the outcome matches the ticket's complaint, say so: "reproduced on qa today". If the
   chain actually completes on qa, say THAT plainly — it is a finding, not a failure of yours.
2. If the scenario does not exist, build only what fits your budget (about ${minutes} minutes): a scenario that
   needs more than a module, one collection with two or three fields, one form or automation and two records is
   NOT worth building here — you cannot see the fix on this backend anyway. In that case screenshot the ticket's
   screens as they are (the empty state included), say plainly in \`summary\` what a human would need to set up,
   and set status \`observed\`. Where you may build depends on the org you are signed into:
   in the agent's OWN org (its name contains "QA Org", e.g. "JMartinez QA Org") the whole org is yours —
   create accounts and modules as the ticket's navigation names them (an "Asset Tracking" module with an
   "Assets" collection, say), so later tickets find them again — but anything you CREATE goes inside a module
   named "Agent ${s.issueKey}" (create it if missing), so two tickets running at the same time never touch each
   other's data. In any other org, build ONLY inside "Agent ${s.issueKey}" — qa is shared with the whole team.
   Either way use the ticket's exact names for what is inside, create the minimum (collections, fields, two or
   three records, the forms or automations), then run step 1.
3. Never delete or rename anything, anywhere.
Caption each screenshot as what it shows today. \`status\` must be \`observed\` (a reproduction on the unpatched
backend proves the bug, never the fix). You are NOT writing tests and you do NOT edit code.` : `You are doing BROWSER QA for ${s.issueKey}: confirm, in a real browser, that the bug the ticket reports
is gone on the FIXED app, and capture screenshots that prove it. The fix is already applied and the local
dev server at ${appUrl} is serving it (Vite HMR — the code you see running is the patched code).${s.backend?.status === 'deployed' ? `
The BACKEND is a private deploy of this branch too (version ${s.backend.versionId}), and the org you are signed into is the agent's own QA org, which PERSISTS across tickets: look at what already exists (collections, fields, records, automations, roles) and reuse it; create only what the ticket's steps still need; never delete or rename anything that exists — another ticket may depend on it. If an existing automation, field or record is configured differently from what the ticket describes, open it and correct it TO the ticket's configuration (a screenshot before and after the edit) — never the other way round: never loosen the configuration the ticket names (e.g. a trigger's By, a role's permission) to make the steps pass; if it only passes that way, that is status bugs_unresolved. Then run the steps. Backend behaviour you trigger — automations, permissions, record writes — runs the fixed code.` : ''} You are NOT
writing tests and you do NOT edit code.`}

## Your tools
\`browser_navigate\`, \`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_select_option\`,
\`browser_take_screenshot\`, \`browser_wait_for\`, \`browser_console_messages\`. If a name is missing, list the
\`mcp__playwright__*\` tools you actually have and use the closest one. The browser is ALREADY SIGNED IN as
${process.env.PAG_APP_EMAIL} — do not sign in again.
Drive by SNAPSHOT, not by pixels: \`browser_snapshot\` gives you the live accessibility tree (real roles and
names). Snapshot before you click, snapshot after to confirm the state changed. A SPA action resolves
asynchronously — \`browser_wait_for\` the expected text instead of assuming it worked.
Do NOT record video (no \`browser_start_video\`): captioned screenshots are the evidence. Your last call is
\`browser_close\`.
If the browser is NOT signed in (a login form appears), that is a pipeline fault, not yours to fix: take one
screenshot of it, write \`status: incomplete\` with the reason "browser was not signed in", and STOP. Never
search the filesystem or environment for credentials, never read or run the pipeline's own scripts, never
inject cookies or tokens. You hold no password and must not look for one.

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
${(s.ticket?.comments || []).length ? `
Newest notes on the ticket thread (a human may say WHERE on this environment the test data was built — account,
module, record names. If they do, go straight there):
${s.ticket.comments.slice(-3).map((c) => `- ${c.author}: ${String(c.body || '').replace(/\s+/g, ' ').slice(0, 700)}`).join('\n')}` : ''}
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
is still visible) · \`incomplete\` (you did not finish)${mode === 'observe' ? ' · `observed` (OBSERVE mode: screens captured as they are today, fix not deployed here — the only status allowed in this mode)' : ''}. Never leave a stale optimistic status.

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
   filename \`${outDir}/NN-slug.png\` (01, 02, … — the ABSOLUTE path, a bare name lands in the wrong folder) and add it to \`steps\` with a caption in the ticket's words. Let the
   page settle first — no spinners mid-frame, scroll the relevant UI into view, dismiss stale toasts.
   Do NOT Read your own screenshots back — you already know what is on the page from the snapshot, and
   every image you read costs more than the whole step. Read at most the final screenshot, once, to
   confirm it shows the acceptance criterion. Trust \`browser_snapshot\` text for everything else.
   After an action that triggers backend work (an automation, a save that fans out), \`browser_wait_for\`
   ~10s, then re-navigate to the record and snapshot — do not spend turns polling.
4. The last screenshot must show the acceptance criterion satisfied — or NOT satisfied, honestly.
5. Check the immediately surrounding behaviour once (same screen, adjacent action) so a regression is caught.
6. Set the final \`status\` and \`summary\`, then \`browser_close\`.

## Budget
About ${minutes} minutes. Aim for 3–8 screenshots. If the screen cannot be reached (missing data you cannot
create, an error page), take a screenshot of where you got stuck, record it in \`unresolvedIssues\`, set
\`status\` honestly, and stop. A truthful partial beats a heroic timeout.

Do NOT edit any file under ${s.repo}. Do NOT run git. Do NOT sign out of the admin account until your
setup is done.`

/** Move screenshots / video / trace the browser session dropped in `cwd` (top level only) into `outDir`. */
export function sweepSessionFiles(cwd, outDir, since) {
  let moved = 0
  try {
    for (const name of fs.readdirSync(cwd)) {
      if (!/^\d\d-[\w.-]+\.png$|\.webm$|^trace.*\.zip$/i.test(name)) continue
      const from = path.join(cwd, name)
      let st; try { st = fs.statSync(from) } catch { continue }
      if (!st.isFile() || st.mtimeMs < since) continue
      fs.renameSync(from, path.join(outDir, name)); moved++
    }
  } catch { /* cwd unreadable: nothing to sweep */ }
  return moved
}

/** null when the API answers (any status but a WAF 403), else a one-line reason. Never throws. */
export async function backendBlocked(url) {
  if (!url) return null
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'probe' }, body: '{"query":"{__typename}"}', signal: AbortSignal.timeout(10_000) })
    if (r.status !== 403) return null
    const text = await r.text().catch(() => '')
    const waf = /WAFForbidden/i.test(text) || /WAF/i.test(r.headers.get('x-amzn-errortype') || '')
    return waf ? `the qa API blocks this runner's IP (AWS WAF 403 on ${new URL(url).host}) — browser QA needs an allow-listed egress (PAG_BROWSER_PROXY) or a laptop; the code evidence stands` : null
  } catch { return null }   // unreachable for another reason: let the session find out and report
}

export function browserQaNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const skip = (reason) => { onProgress(`browser QA skipped: ${reason}`); return { qa: { status: 'skipped', reason } } }
    if (!UI_EVIDENCE) return skip('PAG_UI_EVIDENCE is not 1')
    if (!s.gate?.ok) return skip('the gate is not green')
    const profile = loadProfile(s.repo)
    // verify: the fix is in the web app, the dev server runs it, the screenshots show it working.
    // observe: the fix is in the backend, which this app does NOT run (it calls the deployed qa
    // backend) — so the session walks the ticket's screens as they stand today and captures the exact
    // UI the change affects, labelled as such. Honest context, never presented as proof.
    const deployed = s.backend?.status === 'deployed'
    const mode = ((s.changed || []).some((f) => profile.isUi?.(f)) || deployed) ? 'verify' : s.spec?.symptom?.screen ? 'observe' : null
    if (!mode) return skip('the fix is not in the web app and the ticket names no screen to look at')
    if (!HAS_LOGIN()) return skip('PAG_APP_EMAIL / PAG_APP_PASSWORD are not set to a real account')
    if (!browsermcp.mcpEnabled()) return skip('PAG_WITNESS_MCP=0')
    // Is the backend even reachable from HERE? A bogus key should get 401 Unauthorized from AppSync.
    // 403 WAFForbiddenException means this runner's IP is blocked — on 3436 and 3437 two QA sessions
    // ($4 each) photographed empty screens before anyone read the console. Fail for cents instead,
    // and say so in the PR. (Skipped when the browser has its own egress: PAG_BROWSER_PROXY.)
    const blocked = process.env.PAG_BROWSER_PROXY ? null : await backendBlocked(process.env.VITE_APP_AWS_APPSYNC_GRAPHQL_ENDPOINT)
    if (blocked) return skip(blocked)

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
    const observe = mode === 'observe'
    const spendMs = observe ? Math.min(timeMs, OBSERVE_MINUTES * 60_000) : timeMs
    const spendUsd = observe ? Math.min(OBSERVE_BUDGET_USD, budget.availableFor('repro')) : Math.min(QA_BUDGET_USD, budget.availableFor('repro'))
    const minutes = Math.floor(spendMs / 60_000)
    onProgress(`browser QA (${mode}${mode === 'observe' ? ': backend fix, not deployed here — capturing the ticket\'s screens as they are on qa' : ''}): ${minutes} min, signed in as ${process.env.PAG_APP_EMAIL}, ${ticketShots.length} ticket screenshot(s) to read`)

    const sessionStart = Date.now() - 5_000
    const r = await runClaude({
      cwd: s.repo, model: tier.model, budgetUsd: spendUsd, timeoutMs: spendMs,
      onProgress, mcpConfig,
      prompt: PROMPT(s, { appUrl: app.url, outDir, resultFile, ticketShots, routes: appRoutes(profile), minutes, mode }),
    })
    budget.charge('qa', r.cost, { model: tier.model, subtype: r.subtype, exit: r.code })

    // @playwright/mcp 0.0.80 writes a RELATIVE screenshot/video filename into the MCP server's cwd
    // — the worktree — not into --output-dir (3436 r3: six screenshots and qa.webm taken, "0
    // screenshot(s), video no" collected, and the worktree left dirty). Sweep anything the session
    // produced there into the output dir before collecting; mtime keeps a stray older file out.
    sweepSessionFiles(s.repo, outDir, sessionStart)

    // Whatever the session managed, collect it. The outcome file is the model's word; the PNGs on
    // disk are the evidence. A screenshot the file does not caption still ships, uncaptioned.
    let result = {}
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { /* none written */ }
    const got = await collectShots(outDir, 'after')
    const captions = new Map((result.steps || []).map((x) => [String(x.file || '').replace(/^.*\//, ''), x.caption]))
    const shots = got.shots.map((f) => {
      const base = path.basename(f)
      const original = base.replace(/^after-(\d\d-)?/, (_, n) => n || '')
      return { file: base, caption: captions.get(base) || captions.get(original) || null, path: f }
    }).filter((x) => x.caption || !captions.size) // probe shots the model did not caption stay out once it captioned any
    // Screenshots are the evidence. Video/gif were dropped on purpose: a 30 MB webm per run that reviewers
    // did not open, and the recording calls cost the model turns it needs for the steps themselves.
    for (const x of shots) delete x.path
    saveEvidence('qa-result.json', JSON.stringify(result, null, 2))
    let status = result.status || (r.timedOut ? 'incomplete' : shots.length ? 'incomplete' : 'no_output')
    // never 'passed' in observe mode: nothing here can prove the fix. But an honest 'incomplete'
    // (the backend was unreachable — WAF 403 from the GitHub runner) must not be relabelled
    // 'observed' just because screenshots of the failure exist.
    if (mode === 'observe' && shots.length && status !== 'incomplete') status = 'observed'
    onProgress(`browser QA: ${status} — ${shots.length} screenshot(s), trace ${got.trace ? 'yes' : 'no'}`)
    return {
      qa: {
        status, summary: result.summary || '', unresolved: result.unresolvedIssues || [],
        mode, backend: deployed ? s.backend : null, shots, video: got.video && path.basename(got.video), gif: got.gif && path.basename(got.gif), trace: got.trace && path.basename(got.trace),
        appUrl: app.url, user: process.env.PAG_APP_EMAIL, cost: r.cost,
      },
    }
  }
}
