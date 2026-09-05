import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseCheckNote } from '../src/nodes/publish.mjs'

test('no extra bases configured produces no section at all', () => {
  assert.equal(baseCheckNote([], 'main'), '')
})

test('a green base is named as verified, not merely attempted', () => {
  const out = baseCheckNote([{ target: 'qa', verdict: 'green' }], 'main')
  assert.match(out, /### Other bases/)
  assert.match(out, /`qa` — the owning project's tests pass on the merge/)
  assert.doesNotMatch(out, /no PR opened/)
})

test('a red base says no PR was opened and carries the failing log', () => {
  const out = baseCheckNote([{
    target: 'qa', verdict: 'red',
    why: "the owning project's tests fail on the merge with `qa`",
    out: 'FAIL src/x.repro.test.ts\n  ● boom',
  }], 'main')
  assert.match(out, /\*\*no PR opened\.\*\*/)
  assert.match(out, /verified for `main`/)
  assert.match(out, /<details>/)
  assert.match(out, /● boom/)
})

test('a fenced block inside the log cannot break out of the details block', () => {
  const out = baseCheckNote([{ target: 'qa', verdict: 'red', why: 'x', out: 'before\n```\nafter' }], 'main')
  // exactly the two fences this section opens and closes, and no third from the log
  assert.equal(out.split('\n').filter((l) => l === '```').length, 2)
})

test('unknown and conflict never read as verified', () => {
  for (const verdict of ['unknown', 'conflict']) {
    const out = baseCheckNote([{ target: 'qa', verdict, why: 'because' }], 'main')
    assert.match(out, /no PR opened/)
    assert.doesNotMatch(out, /tests pass/)
  }
})

test('several bases each get their own line', () => {
  const out = baseCheckNote([
    { target: 'qa', verdict: 'green' },
    { target: 'staging', verdict: 'unknown', why: 'no clock left' },
  ], 'main')
  assert.match(out, /`qa`/)
  assert.match(out, /`staging`/)
  assert.match(out, /no clock left/)
})
