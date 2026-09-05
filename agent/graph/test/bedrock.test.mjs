// Telling "the answer was cut off" apart from "the answer was wrong". They need opposite
// responses — a bigger budget vs a different prompt — and on ESI2-3393 confusing them turned a
// retryable truncation into a dead run at the planning node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksTruncated } from '../src/lib/bedrock.mjs'

test('the real ESI2-3393 body: valid JSON cut off mid-string', () => {
  const body = '{\n "impactedFiles": [\n  "packages/libs/data-format/src/group-separators.ts"\n ],\n'
    + ' "steps": [\n  "Examine the NUMERIC_VALUE_REGEX in group-separators.ts: the pattern allows up to 16 decimal places, but the '
  assert.equal(looksTruncated(body), true)
})

test('complete JSON is not truncated', () => {
  assert.equal(looksTruncated('{"impactedFiles":["a.ts"],"steps":["one","two"],"newTests":[]}'), false)
  assert.equal(looksTruncated('[]'), false)
  assert.equal(looksTruncated('{}'), false)
})

test('unclosed containers are truncated', () => {
  assert.equal(looksTruncated('{"a":[1,2'), true)
  assert.equal(looksTruncated('{"a":{"b":1}'), true)
})

test('prose is malformed, NOT truncated — it needs a different prompt, not a bigger budget', () => {
  assert.equal(looksTruncated('Sure! Here is the plan you asked for.'), false)
  assert.equal(looksTruncated(''), false)
})

test('escapes and braces inside strings do not fool the depth count', () => {
  assert.equal(looksTruncated('{"a":"say \\"hi\\""}'), false)
  assert.equal(looksTruncated('{"a":"a } b ] c"}'), false)
  assert.equal(looksTruncated('{"a":"trailing backslash \\\\"}'), false)
})

// ---------------------------------------------------------------------------------------------
// repairJson: the ESI2-3393 killer. A plan step that quotes a regex puts a lone backslash inside a
// JSON string, `\d` is not a legal JSON escape, and the whole object is unparseable however many
// tokens it gets. It read as truncation because the error printed only the first 300 characters.
import { repairJson } from '../src/lib/bedrock.mjs'

test('repairs the real ESI2-3393 body: a regex quoted inside a plan step', () => {
  const body = '{"impactedFiles":["a.ts"],"steps":["it allows `(\\\\.\\d{1,16})?` for the decimal part"]}'
  assert.throws(() => JSON.parse(body))
  const r = repairJson(body)
  assert.ok(r, 'should have been repaired')
  assert.deepEqual(r.impactedFiles, ['a.ts'])
  assert.match(r.steps[0], /\(\\\.\\d\{1,16\}\)\?/)
})

test('a VALID escape pair is not broken by the repair', () => {
  // The naive fix scans left to right, "repairs" the second backslash of a legal \\ pair, and
  // produces JSON that is broken in a new way. The alternation consumes the pair as a unit.
  const ok = '{"a":"line\\nbreak","b":"back\\\\slash","c":"quote\\"inside","d":"\\u00e9"}'
  const parsed = JSON.parse(ok)
  assert.deepEqual(repairJson(ok), parsed, 'valid JSON must survive the repair unchanged')
})

test('trailing commas are dropped', () => {
  assert.deepEqual(repairJson('{"a":[1,2,],"b":1,}'), { a: [1, 2], b: 1 })
})

test('genuinely broken JSON is not guessed at', () => {
  // Guessing produces a plan that parses and means something the model never said.
  assert.equal(repairJson('{"a": }'), null)
  assert.equal(repairJson('Sure! Here is the plan.'), null)
  assert.equal(repairJson('{"a":1'), null)
})
