// What a reviewer actually sees. Every image in a PR body has to be an absolute raw URL on a
// branch GitHub can serve — a relative `evidence/x.png` renders as a broken image, and a broken
// image in the one section that exists to prove the fix is worse than no section at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceBlock } from '../src/nodes/publish.mjs'

const budget = { maxMinutes: 30, elapsedMs: () => 0, report: () => ({ spent: 0 }) }
const href = (f) => `https://github.com/AssetPandaLLC/pioneer/blob/agent-evidence/ESI2-3393/run1/${encodeURIComponent(f)}?raw=true`
const base = { issueKey: 'ESI2-3393', baseBranch: 'main', baseSha: 'ca0e666abc', gate: { summary: 'green' }, scope: { owners: ['libs-import'] } }

test('a unit-rung PR embeds both terminal images as raw URLs', () => {
  const s = {
    ...base,
    repro: { status: 'red', rung: 'unit', file: 'packages/libs/import/x.repro.test.ts', sha: 'b5e2c466a211ff', cmd: 'npx nx run libs-import:test', redExcerpt: 'FAIL' },
    evidence: { reproGreen: true, greenExcerpt: 'PASS' },
  }
  const md = evidenceBlock(s, budget, href, { before: 'terminal-before.png', after: 'terminal-after.png' })
  assert.match(md, /!\[before\]\(https:\/\/github\.com\/.*terminal-before\.png\?raw=true\)/)
  assert.match(md, /!\[after\]\(https:\/\/github\.com\/.*terminal-after\.png\?raw=true\)/)
  assert.ok(!/\]\(evidence\//.test(md), 'a relative evidence/ path would render as a broken image')
  // The text must survive alongside the pictures — it is the part a reviewer can copy and re-run.
  assert.match(md, /Before this patch/)
  assert.match(md, /After this patch/)
})

test('a UI ticket embeds the reporter\'s screenshots, the browser-QA after-shots with captions, and the video', () => {
  const s = {
    ...base,
    ticketShots: [{ file: 'ticket-01-tab-missing.png', name: 'tab-missing.png' }],
    qa: {
      status: 'passed', appUrl: 'http://localhost:3000', user: 'qa@example.com',
      summary: 'Attachments tab now visible for the Read-Only role; adjacent tabs unaffected.',
      shots: [
        { file: 'after-01-record-open.png', caption: 'Record 1696 opened as the Read-Only user' },
        { file: 'after-02-full-details-tabs.png', caption: 'View Full Details: Attachments tab present' },
      ],
      video: 'after.webm', gif: 'after.gif', trace: 'after-trace.zip', unresolved: [],
    },
  }
  const md = evidenceBlock(s, budget, href, null)
  assert.ok(md.indexOf('Reported in the ticket') < md.indexOf('Verified on the fixed app'), 'before comes before after')
  for (const f of ['ticket-01-tab-missing.png', 'after-01-record-open.png', 'after-02-full-details-tabs.png', 'after.gif', 'after.webm', 'after-trace.zip']) {
    assert.ok(md.includes(encodeURIComponent(f)) || md.includes(f), `${f} is missing from the PR body`)
  }
  assert.match(md, /Attachments tab present/)
  assert.match(md, /the reported symptom is gone/)
})

test('a browser QA that could not confirm the fix says so instead of looking green', () => {
  const s = { ...base, qa: { status: 'bugs_unresolved', summary: 'tab still hidden for the custom role', shots: [{ file: 'after-01-still-hidden.png', caption: 'still hidden' }], unresolved: [{ issue: 'tab hidden', impact: 'bug not fixed', nextStep: 'check validateAccess for custom roles' }] } }
  const md = evidenceBlock(s, budget, href, null)
  assert.match(md, /NOT confirmed fixed/)
  assert.match(md, /Open issues the QA session recorded/)
  assert.match(md, /check validateAccess for custom roles/)
})

test('no images captured still produces a readable evidence section', () => {
  const s = { ...base, repro: { status: 'red', rung: 'unit', file: 'x.repro.test.ts', sha: 'aa', redExcerpt: 'FAIL' }, evidence: { reproGreen: true, greenExcerpt: 'PASS' } }
  const md = evidenceBlock(s, budget, href, null)
  assert.ok(!md.includes('!['), 'should not emit an image tag when nothing was rendered')
  assert.match(md, /Reproducing test/)
})

test('no reproducing test says so plainly instead of implying proof', () => {
  const s = { ...base, repro: { status: 'none', reason: 'the symptom is backend-only' }, evidence: null }
  const md = evidenceBlock(s, budget, href, null)
  assert.match(md, /No reproducing test/)
  assert.match(md, /does not prove the reported symptom is gone/)
})

test('a no-repro run still shows the gate transcript and says why there are no UI shots', () => {
  const s = {
    issueKey: 'ESI2-3406', baseBranch: 'main', baseSha: 'abcdef1234',
    repro: { status: 'none', reason: 'needs an authenticated session' },
    gate: { ok: true, summary: 'green across 1 owning project(s)' },
    scope: { owners: ['clients-web-app'] },
  }
  const out = evidenceBlock(s, { maxMinutes: 30 }, (f) => `E/${f}`, { gate: 'terminal-gate.png' })
  assert.match(out, /No reproducing test/)
  assert.match(out, /!\[the gate on the patched tree\]\(E\/terminal-gate\.png\)/)
  assert.match(out, /No UI screenshots/)
  assert.match(out, /PAG_APP_EMAIL/)
})

test('a red-to-green run is unchanged by the gate-only fallback', () => {
  const s = {
    issueKey: 'ESI2-3393', baseBranch: 'main', baseSha: 'abcdef1234',
    repro: { status: 'red', file: 'a/b.repro.test.ts', sha: 'deadbeefcafe', cmd: 'npx nx run p:test', redExcerpt: 'FAIL' },
    evidence: { reproGreen: true, greenExcerpt: 'PASS' },
    gate: { ok: true, summary: 'green' }, scope: { owners: ['p'] },
  }
  const out = evidenceBlock(s, { maxMinutes: 30 }, (f) => `E/${f}`, { before: 'terminal-before.png', after: 'terminal-after.png' })
  assert.doesNotMatch(out, /No UI screenshots/)
  assert.doesNotMatch(out, /the gate on the patched tree/)
  assert.match(out, /terminal-before\.png/)
})

test("the ticket's own screenshots lead the Evidence section and are re-hosted, not linked to Jira", () => {
  const s = {
    issueKey: 'ESI2-3406', baseBranch: 'main', baseSha: 'abcdef1234',
    ticketShots: [{ file: 'ticket-01-tab-missing.png', name: 'tab-missing.png' }],
    repro: { status: 'none', reason: 'needs an authenticated session' },
    gate: { ok: true, summary: 'green' }, scope: { owners: ['w'] },
  }
  const out = evidenceBlock(s, { maxMinutes: 30 }, (f) => `E/${f}`, null)
  assert.match(out, /Reported in the ticket/)
  assert.match(out, /!\[tab-missing\.png\]\(E\/ticket-01-tab-missing\.png\)/)
  assert.doesNotMatch(out, /atlassian\.net/)
  // and it comes before the run's own findings
  assert.ok(out.indexOf('Reported in the ticket') < out.indexOf('No reproducing test'))
})

test('a ticket with no screenshots gets no empty section', () => {
  const s = { issueKey: 'X-1', baseBranch: 'main', baseSha: 'abc', repro: { status: 'none' }, gate: {} }
  assert.doesNotMatch(evidenceBlock(s, {}, (f) => f, null), /Reported in the ticket/)
})

test('a UI symptom fixed in a lambda says why no app screenshots exist', () => {
  const s = {
    issueKey: 'ESI2-3393', baseBranch: 'main', baseSha: 'abcdef1234',
    spec: { symptom: { screen: "the import 'Review & Finalize' step" } },
    scope: { owners: ['lambdas-fns-import-one-schema-template'] },
    repro: { status: 'red', rung: 'unit', file: 'a/b.repro.test.ts', sha: 'deadbeef', redExcerpt: 'FAIL' },
    evidence: { reproGreen: true, greenExcerpt: 'PASS' },
    gate: { ok: true, summary: 'green' },
  }
  const out = evidenceBlock(s, { maxMinutes: 30 }, (f) => `E/${f}`, null)
  assert.match(out, /Why there are no app screenshots/)
  assert.match(out, /Review & Finalize/)
  assert.match(out, /deployed backend/)
})

test('a run with browser-QA screenshots does not carry that explanation', () => {
  const s = {
    issueKey: 'X-1', baseBranch: 'main', baseSha: 'abc',
    spec: { symptom: { screen: 'the record detail tab bar' } },
    repro: { status: 'red', rung: 'component', file: 'x.repro.test.tsx', sha: 'aa', redExcerpt: 'FAIL' },
    evidence: { reproGreen: true, greenExcerpt: 'PASS' },
    qa: { status: 'passed', shots: [{ file: 'after-01.png', caption: 'tab visible' }] },
    gate: { ok: true, summary: 'green' }, scope: { owners: ['w'] },
  }
  assert.doesNotMatch(evidenceBlock(s, {}, (f) => f, null), /Why there are no app screenshots/)
})

