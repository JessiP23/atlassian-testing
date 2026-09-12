import test from 'node:test'
import assert from 'node:assert/strict'
import { addComment, transition, swapLabel, JIRA_READONLY } from '../src/lib/jira.mjs'
import { previewOrigin } from '../src/lib/preview.mjs'

// A full run against a REAL ticket, leaving no trace on it. Every Jira WRITE is held back in one
// place, so a caller that forgets to check the flag cannot write by accident.
test('read-only holds back every write and touches no network', async () => {
  process.env.PAG_JIRA_READONLY = '1'
  assert.equal(JIRA_READONLY(), true)
  assert.deepEqual(await addComment('ESI2-1', 'would have commented'), { readOnly: true })
  assert.deepEqual(await swapLabel('ESI2-1', 'A', 'B'), { readOnly: true })
  const t = await transition('ESI2-1', ['Done'])
  assert.equal(t.moved, false)
  assert.equal(t.readOnly, true)
  delete process.env.PAG_JIRA_READONLY
  assert.equal(JIRA_READONLY(), false)
})

test('the preview origin is the base wildcard, not a version\'s own', async () => {
  process.env.PAG_PREVIEW_DOMAIN = '*.jessi-panda-app.com'
  assert.equal(await previewOrigin(process.env), 'https://jessi-panda-app.com')
  delete process.env.PAG_PREVIEW_DOMAIN
})
