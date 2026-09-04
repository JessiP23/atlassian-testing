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
