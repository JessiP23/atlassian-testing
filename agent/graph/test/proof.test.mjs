import test from 'node:test'
import assert from 'node:assert/strict'
import { proofFromState, proofBlock } from '../src/lib/proof.mjs'

const base = {
  baseSha: 'cb4f234abcdef',
  spec: { symptom: { screen: 'Accessory Assignment form, after Submit', errorText: '' }, riskNotes: ['form configuration not visible in the ticket'] },
  ticket: { attachments: [{ filename: 'case.mp4', mimeType: 'video/mp4' }, { filename: 'shot.png', mimeType: 'image/png' }] },
  ticketShots: [{ file: 'ticket-01-shot.png' }],
  changed: ['a.ts', 'b.ts'],
}

test('ESI2-3437 shape: red→green proven, observe-mode QA proves the bug not the fix, unread video is named', () => {
  const p = proofFromState({
    ...base,
    repro: { status: 'red', file: 'x.repro.test.ts', reusedFrom: '2026-09-10T04-54-20-345Z' },
    evidence: { reproGreen: true },
    patchReport: 'Root cause: a later calculate action returned {} and overwrote the pending write-back. Changed three files.',
    qa: { status: 'observed', summary: 'OBSERVE mode. The related record was not updated. More detail.', shots: [{}, {}, {}] },
  })
  assert.equal(p.confirmed.length, 4)
  assert.match(p.confirmed[1].claim, /re-run red on this base/)
  assert.match(p.confirmed[3].claim, /Reproduced on the unpatched qa backend today: OBSERVE mode\./)
  assert.equal(p.inferred.length, 1)
  assert.match(p.inferred[0].claim, /^Root cause as the agent read it: Root cause: a later calculate action returned \{\} and overwrote the pending write-back\./)
  const un = p.unverified.map((x) => x.claim)
  assert.ok(un.some((c) => c.includes('"case.mp4" (video/mp4) was not read')))
  assert.ok(!un.some((c) => c.includes('shot.png')), 'images are read, not listed as unread')
  assert.ok(un.some((c) => c.startsWith('The fix itself was not exercised')))
  assert.ok(un.includes('form configuration not visible in the ticket'))
})

test('no repro, QA skipped: says so instead of hiding it', () => {
  const p = proofFromState({ ...base, ticket: { attachments: [] }, repro: { status: 'none' }, qa: { status: 'skipped', reason: 'could not sign in' } })
  assert.ok(p.unverified.some((x) => x.claim.startsWith('No reproducing test')))
  assert.ok(p.unverified.some((x) => x.claim.includes('did not complete (skipped): could not sign in')))
  assert.equal(p.confirmed.length, 1) // the symptom from the ticket
})

test('hypotheses with verdicts land in the right group', () => {
  const p = proofFromState({
    ...base, ticket: { attachments: [] }, repro: { status: 'red', file: 'r.ts' }, evidence: { reproGreen: true },
    plan: { hypotheses: [
      { statement: 'H1', verdict: 'confirmed', evidence: 'r.ts fails on base' },
      { statement: 'H2', verdict: 'rejected' },
      { statement: 'H3', check: 'compare the customer form action field ids' },
    ] },
  })
  assert.ok(p.confirmed.some((x) => x.claim === 'Hypothesis held: H1'))
  assert.ok(p.inferred.some((x) => x.claim === 'Ruled out: H2'))
  assert.ok(p.unverified.some((x) => x.claim === 'Not ruled in or out: H3' && x.how.startsWith('compare')))
})

test('block renders all three groups, empty ones stated', () => {
  const md = proofBlock({ confirmed: [], inferred: [{ claim: 'x', basis: 'y' }], unverified: [] })
  assert.match(md, /^## What is proven, inferred, and not verified/)
  assert.match(md, /\*\*Proven\*\* \(0\)\n- nothing — read the diff as a proposal/)
  assert.match(md, /- x — _y_/)
  assert.match(md, /\*\*Not verified here\*\* \(0\)[^\n]*\n- nothing outstanding/)
})
