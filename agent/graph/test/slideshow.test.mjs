import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSlideshow } from '../src/lib/repro.mjs'

test('slideshow: needs at least two frames, never throws', async () => {
  assert.equal(await makeSlideshow([], '/tmp/x.gif'), null)
  assert.equal(await makeSlideshow(['/nonexistent/a.png'], '/tmp/x.gif'), null)
  // two missing files: ffmpeg fails → null, no throw
  assert.equal(await makeSlideshow(['/nonexistent/a.png', '/nonexistent/b.png'], '/tmp/x.gif'), null)
})
