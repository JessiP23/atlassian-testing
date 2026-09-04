// The routing table. These four functions decide whether 20 minutes of work becomes a PR, a
// second attempt, a hand-over, or nothing — and the hand-over branch is new, so it is the one most
// worth pinning. Every case below is a real terminal state a run has actually reached.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterPatch, afterVerifyWith, afterRepair } from '../src/graph.mjs'
import { Budget } from '../src/lib/budget.mjs'
import { MAX_REPAIR_ATTEMPTS, MAX_REPLANS } from '../src/state.mjs'

const clock = (minutesUsed) => { const b = new Budget({ maxMinutes: 20 }); b.t0 = Date.now() - minutesUsed * 60_000; return b }
const green = { gate: { ok: true }, changed: ['app/page.tsx'] }
const red = { gate: { ok: false, summary: 'lint failed' }, changed: ['app/page.tsx'] }

test('a green gate goes to approve, always', () => {
  assert.equal(afterVerifyWith(clock(0))(green), 'approve')
  assert.equal(afterVerifyWith(clock(19.9))(green), 'approve', 'a green run must publish even at the deadline')
})

test('a red gate with attempts and clock goes to repair', () => {
  assert.equal(afterVerifyWith(clock(2))({ ...red, attempts: 0 }), 'repair')
  assert.equal(afterVerifyWith(clock(2))({ ...red, attempts: MAX_REPAIR_ATTEMPTS - 1 }), 'repair')
})

test('THE KAN-6 CASE: out of clock with a diff hands over instead of refusing', () => {
  // 19 of 20 minutes gone, gate red, one attempt used. The old code refused `time_budget` here and
  // the branch, the diff and eight before/after screenshots were deleted.
  const r = afterVerifyWith(clock(19))({ ...red, attempts: 1 })
  assert.equal(r, 'handover')
})

test('out of attempts hands over too', () => {
  assert.equal(afterVerifyWith(clock(3))({ ...red, attempts: MAX_REPAIR_ATTEMPTS }), 'handover')
})

test('nothing to hand over is still a refusal', () => {
  assert.equal(afterVerifyWith(clock(19))({ gate: { ok: false }, changed: [], attempts: 9 }), 'refuse')
  assert.equal(afterVerifyWith(clock(19))({ gate: { ok: false }, attempts: 9 }), 'refuse')
})

test('a fatal refusal is never salvaged — a leaked credential does not become a PR', () => {
  const leaked = { refusal: { at: 'verify', reason: 'secret_in_diff' }, changed: ['app/x.ts'], gate: { ok: false } }
  assert.equal(afterVerifyWith(clock(1))(leaked), 'refuse')
  const tampered = { refusal: { at: 'verify', reason: 'repro_tampered' }, changed: ['app/x.ts'] }
  assert.equal(afterVerifyWith(clock(1))(tampered), 'refuse')
})

test('repair that had no clock to try hands over rather than dying', () => {
  assert.equal(afterRepair({ outOfTime: true, changed: ['app/x.ts'] }), 'handover')
  assert.equal(afterRepair({ outOfTime: true, changed: [] }), 'refuse')
  assert.equal(afterRepair({ changed: ['app/x.ts'] }), 'verify')
  assert.equal(afterRepair({ refusal: { reason: 'budget_exhausted' } }), 'refuse')
})

test('patch escalation re-plans once, with named files, then stops', () => {
  assert.equal(afterPatch({ escalation: { neededFiles: ['app/lib/auth.ts'] }, replans: 0 }), 'planning')
  assert.equal(afterPatch({ escalation: { neededFiles: ['app/lib/auth.ts'] }, replans: MAX_REPLANS }), 'refuse')
  assert.equal(afterPatch({ escalation: { neededFiles: [] }, replans: 0 }), 'refuse', 'nothing to widen')
  assert.equal(afterPatch({ changed: ['app/x.ts'] }), 'verify')
})

test('every route a predicate can return is a node the graph declares', () => {
  const declared = new Set(['intake', 'locate', 'planning', 'reproduce', 'patch', 'verify', 'repair', 'handover', 'approve', 'publish', 'refuse'])
  const returned = [
    afterVerifyWith(clock(0))(green), afterVerifyWith(clock(2))({ ...red, attempts: 0 }),
    afterVerifyWith(clock(19))({ ...red, attempts: 1 }), afterVerifyWith(clock(19))({ gate: { ok: false } }),
    afterRepair({ outOfTime: true, changed: ['x'] }), afterRepair({}),
    afterPatch({ escalation: { neededFiles: ['x'] }, replans: 0 }), afterPatch({}),
  ]
  for (const r of returned) assert.ok(declared.has(r), `route "${r}" is not a declared node`)
})

test('ESI2-3393: failures only in the frozen repro file skip repair entirely', () => {
  // repair is told it may not edit the reproducing test, and verify hash-checks it. Three attempts
  // that each correctly answer "the failures are in the file I am not allowed to edit" is $0.75
  // and 130s of nothing.
  const frozen = 'packages/libs/import/src/records-processor/format-filter-value.repro.test.ts'
  const s = {
    gate: { ok: false, failures: [{ file: frozen, rule: 'no-extra-semi' }, { file: frozen, rule: '@nx/enforce-module-boundaries' }] },
    repro: { status: 'red', file: frozen },
    changed: ['packages/lambdas/fns/import-one-schema-template/src/one-schema-template/get-template-columns.ts'],
    attempts: 0,
  }
  assert.equal(afterVerifyWith(clock(3))(s), 'handover')
})

test('a failure outside the frozen file still goes to repair', () => {
  const frozen = 'app/x.repro.test.ts'
  const s = {
    gate: { ok: false, failures: [{ file: frozen, rule: 'no-extra-semi' }, { file: 'app/real.ts', rule: 'TS2322' }] },
    repro: { status: 'red', file: frozen },
    changed: ['app/real.ts'], attempts: 0,
  }
  assert.equal(afterVerifyWith(clock(3))(s), 'repair')
})
