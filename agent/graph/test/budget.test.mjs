// The clock. The property that matters is not "phases get their ceilings" — it is "publish always
// has time", because a run that produces nothing at minute 20 is worse than no deadline at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Budget, PHASES, PHASE_ORDER, downstreamMs } from '../src/lib/budget.mjs'

const at = (minutesUsed, maxMinutes = 20) => {
  const b = new Budget({ maxMinutes })
  b.t0 = Date.now() - minutesUsed * 60_000
  return b
}

test('a fresh run gives every phase its full ceiling', () => {
  const b = at(0)
  for (const n of ['reproduce', 'patch', 'verify']) {
    assert.equal(b.timeFor(n), PHASES[n].ceilMs, `${n} should get its ceiling on a fresh run`)
  }
})

test('no phase can ever exceed its own ceiling, however much clock is left', () => {
  const b = at(0, 120)                     // a two-hour budget
  for (const n of PHASE_ORDER) {
    assert.ok(b.timeFor(n) <= PHASES[n].ceilMs, `${n} exceeded its ceiling with a huge budget`)
  }
})

test('an early phase cannot eat what the later ones need', () => {
  // 14 of 20 minutes gone: reproduce must not claim its 6-minute ceiling, because patch, verify
  // and publish still have to happen inside the remaining 6.
  const b = at(14)
  assert.ok(b.timeFor('reproduce') < PHASES.reproduce.ceilMs)
  assert.ok(b.timeFor('reproduce') <= b.timeLeftMs() - downstreamMs('reproduce'))
})

test('publish is never reserved against — it is the deliverable', () => {
  assert.equal(downstreamMs('publish'), 0)
  const b = at(19.5)                       // 30 seconds left
  assert.ok(b.timeFor('publish') > 0, 'publish was starved, which is the one thing that must not happen')
})

test('repair reserves nothing for itself, so it never squeezes publish out', () => {
  assert.equal(PHASES.repair.needMs, 0)
})

test('past the deadline every model phase is closed and publish still is not', () => {
  const b = at(21)
  assert.equal(b.pastDeadline(), true)
  assert.equal(b.timeFor('patch'), 0)
  assert.equal(b.timeFor('reproduce'), 0)
  assert.equal(b.timeFor('publish'), 0)    // 0 means "the graph must hand over", not "crash"
  assert.equal(b.hasTimeFor('repair'), false)
})

test('hasTimeFor is the gate the graph routes on', () => {
  assert.equal(at(0).hasTimeFor('repair', 45_000), true)
  assert.equal(at(19.9).hasTimeFor('repair', 45_000), false)
})

test('the phase order matches the graph, or the reserves are computed against the wrong future', () => {
  assert.deepEqual(PHASE_ORDER, ['intake', 'locate', 'planning', 'reproduce', 'patch', 'verify', 'repair', 'package', 'publish'])
  for (const n of PHASE_ORDER) assert.ok(PHASES[n], `${n} is in the order but has no phase entry`)
})

test('the declared reserves fit inside the deadline', () => {
  // If the sum of every phase's typical need exceeded the budget, the arithmetic would starve the
  // phase in hand on every single run rather than only on slow ones.
  const need = PHASE_ORDER.reduce((t, n) => t + PHASES[n].needMs, 0)
  assert.ok(need < 20 * 60_000, `typical needs total ${need / 1000}s, which does not fit in 20 minutes`)
})

test('dollars and minutes are independent guards', () => {
  const b = new Budget({ capUsd: 15, reserveUsd: 2, maxMinutes: 20 })
  b.charge('patch', 13.5)
  assert.equal(b.availableFor('patch'), 0)          // pre-publish phases are capped at cap-reserve
  assert.ok(b.availableFor('publish') > 0)          // the reserve is still there for the PR
  assert.ok(b.timeFor('patch') > 0)                 // money is gone, clock is not
})

test('phases are recorded for the PR footer', () => {
  const b = at(0)
  b.recordPhase('patch', 186_000)
  assert.deepEqual(b.report().phases, [{ node: 'patch', ms: 186_000 }])
})
