import test from 'node:test'
import assert from 'node:assert/strict'
import { hypothesisVerdicts } from '../src/nodes/reproduce.mjs'

const hs = [
  { id: 'H1', statement: 'later calculate action overwrites the pending write-back', check: 'two actions, second targets self', checkable: 'test' },
  { id: 'H2', statement: 'action references a field id invalidated by restoration', check: 'compare customer field ids', checkable: 'data' },
  { id: 'H3', statement: 'linked record lookup fails silently', check: 'missing pullFrom reference', checkable: 'test' },
]

test('named red + ruled-out are stamped; data hypotheses stay open', () => {
  const v = hypothesisVerdicts(hs, 'some prose\nREPRO: red H3 ruled-out: H1, H2', 'x.repro.test.ts')
  assert.equal(v.held, 'H3')
  assert.equal(v.hypotheses[2].verdict, 'confirmed')
  assert.equal(v.hypotheses[0].verdict, 'rejected')
  assert.equal(v.hypotheses[1].verdict, undefined, 'a data hypothesis cannot be ruled out by a unit test')
})

test('a bare REPRO: red means H1; unknown ids are ignored; no hypotheses → nothing', () => {
  assert.equal(hypothesisVerdicts(hs, 'REPRO: red', 'f').held, 'H1')
  assert.equal(hypothesisVerdicts(hs, 'REPRO: red H9', 'f').held, null)
  assert.deepEqual(hypothesisVerdicts([], 'REPRO: red H1', 'f'), { held: null, hypotheses: null, note: '' })
})

test('a data hypothesis cannot be "held" by a test even if the model says so', () => {
  assert.equal(hypothesisVerdicts(hs, 'REPRO: red H2', 'f').held, null)
})

import { ruledOutVerdicts } from '../src/nodes/reproduce.mjs'
import { noTestableExplanationLeft, afterReproduce } from '../src/graph.mjs'

test('REPRO: none with ruled-out stamps the testable hypotheses; the graph then refuses instead of patching', () => {
  const v = ruledOutVerdicts(hs, 'analysis…\nREPRO: none the mechanism is absent; ruled-out: H1, H3', 'f')
  assert.equal(v.hypotheses[0].verdict, 'rejected')
  assert.equal(v.hypotheses[2].verdict, 'rejected')
  assert.equal(v.hypotheses[1].verdict, undefined, 'data hypothesis untouched')
  assert.equal(noTestableExplanationLeft(v.hypotheses), true)
  assert.equal(afterReproduce({ repro: { status: 'none' }, plan: { hypotheses: v.hypotheses } }), 'refuse')
})

test('no red test but a testable explanation still open → patch proceeds (a red test is not mandatory)', () => {
  const v = ruledOutVerdicts(hs, 'REPRO: none needs a browser; ruled-out: H1', 'f')
  assert.equal(noTestableExplanationLeft(v.hypotheses), false)
  assert.equal(afterReproduce({ repro: { status: 'none' }, plan: { hypotheses: v.hypotheses } }), 'patch')
  assert.equal(afterReproduce({ repro: { status: 'none' }, plan: {} }), 'patch', 'no hypotheses at all: old behaviour')
  assert.equal(afterReproduce({ repro: { status: 'red' }, plan: { hypotheses: v.hypotheses } }), 'patch')
})
