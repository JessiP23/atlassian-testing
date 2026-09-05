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

test('a UI-rung PR embeds the paired screenshots AND the terminal images', () => {
  const s = {
    ...base,
    repro: {
      status: 'red', rung: 'e2e', file: '/runs/x/KAN.spec.mjs', sha: 'abc123def456', appUrl: 'http://localhost:3000',
      before: { shots: ['before-01-initial.png', 'before-02-toggled.png'], video: 'before.webm' },
    },
    evidence: {
      reproGreen: true,
      after: { shots: ['after-01-initial.png', 'after-02-toggled.png', 'after-03-reloaded.png'], gif: 'after.gif', video: 'after.webm' },
    },
  }
  const md = evidenceBlock(s, budget, href, { before: 'terminal-before.png', after: 'terminal-after.png' })
  for (const f of ['before-01-initial.png', 'after-01-initial.png', 'after-03-reloaded.png', 'after.gif', 'terminal-before.png']) {
    assert.ok(md.includes(encodeURIComponent(f)), `${f} is missing from the PR body`)
  }
  assert.match(md, /_not reached before the fix_/)   // the state the broken build never got to
  assert.ok(!/\]\(evidence\//.test(md))
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
