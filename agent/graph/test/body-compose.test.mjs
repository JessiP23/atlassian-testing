import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * PR #15820 carried its Evidence section and file list TWICE: once with relative `evidence/...`
 * hrefs that render as alt text on GitHub, then again with working evidence-branch URLs. Cause:
 * `body(href)` read `pr.body`, and the first call `pr.body = body()` had already replaced it with
 * the whole composed body, which the second call then nested inside itself.
 *
 * This pins the shape of that composition without booting the node.
 */
const compose = (narrative, href) => [`> banner`, '', narrative, '', `## Evidence\n![shot](${href('a.png')})`, '', '## Files changed\nx.ts'].join('\n')

test('composing twice does not nest the first result inside the second', () => {
  const pr = { body: 'The root cause was X.' }
  const narrative = pr.body                       // captured ONCE, before any composition
  pr.body = compose(narrative, (f) => `evidence/${f}`)
  pr.body = compose(narrative, (f) => `https://evidence/${f}`)
  assert.equal(pr.body.match(/## Evidence/g).length, 1, 'exactly one Evidence section')
  assert.equal(pr.body.match(/## Files changed/g).length, 1, 'exactly one file list')
  assert.doesNotMatch(pr.body, /\(evidence\/a\.png\)/, 'no relative href survives the second pass')
  assert.match(pr.body, /https:\/\/evidence\/a\.png/)
})

test('the bug it replaces: reading the mutated field nests and duplicates', () => {
  const pr = { body: 'The root cause was X.' }
  pr.body = compose(pr.body, (f) => `evidence/${f}`)
  pr.body = compose(pr.body, (f) => `https://evidence/${f}`)   // the old behaviour
  assert.equal(pr.body.match(/## Evidence/g).length, 2)
  assert.match(pr.body, /\(evidence\/a\.png\)/, 'the broken relative href is still in there')
})
