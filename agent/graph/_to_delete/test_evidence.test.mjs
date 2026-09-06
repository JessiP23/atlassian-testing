// The before/after table. This logic was wrong in a way the operator caught by eye ("i dont see
// the icon button because there is just screens from the before but nto after"), so it gets a test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairShots, stateKey, stateLabel } from '../src/lib/evidence.mjs'

test('keys strip the run label and the extension', () => {
  assert.equal(stateKey('before-02-after-toggle-dark.png'), '02-after-toggle-dark')
  assert.equal(stateKey('after-02-after-toggle-dark.png'), '02-after-toggle-dark')
})

test('labels read like English, not like filenames', () => {
  assert.equal(stateLabel('03-reloaded-still-dark'), 'reloaded still dark')
  assert.equal(stateLabel('01-initial-load'), 'initial load')
})

test('THE BUG: unequal frame counts must not shift the rows', () => {
  // The red run dies partway and captures 2 states; the green run completes and captures 4.
  // Index pairing put `01-initial-load` next to `03-reloaded-still-dark` and the table lied.
  const before = ['before-01-initial-load.png', 'before-02-after-toggle-dark.png']
  const after = ['after-01-initial-load.png', 'after-02-after-toggle-dark.png',
    'after-03-reloaded-still-dark.png', 'after-04-toggled-back-light.png']
  const { rows, missingBefore } = pairShots(before, after)
  assert.equal(rows.length, 4)
  for (const r of rows) {
    if (r.before) assert.equal(stateKey(r.before), stateKey(r.after), 'a row paired two different states')
  }
  assert.deepEqual(missingBefore, ['03-reloaded-still-dark', '04-toggled-back-light'])
})

test('a state the broken build never reached is reported as such, not dropped', () => {
  const { rows } = pairShots(['before-01-a.png'], ['after-01-a.png', 'after-02-b.png'])
  const b = rows.find((r) => r.key === '02-b')
  assert.equal(b.before, null)
  assert.ok(b.after)
})

test('rows are in the order a user meets them', () => {
  const shots = ['after-03-c.png', 'after-01-a.png', 'after-02-b.png']
  assert.deepEqual(pairShots([], shots).rows.map((r) => r.key), ['01-a', '02-b', '03-c'])
})

test('a witness that produced nothing yields an empty table, not a crash', () => {
  assert.deepEqual(pairShots(), { rows: [], missingBefore: [], missingAfter: [] })
  assert.deepEqual(pairShots(undefined, undefined).rows, [])
})

test('the table is capped so a 30-state spec does not bury the PR', () => {
  const many = Array.from({ length: 30 }, (_, i) => `after-${String(i).padStart(2, '0')}-s.png`)
  assert.equal(pairShots([], many).rows.length, 8)
})
