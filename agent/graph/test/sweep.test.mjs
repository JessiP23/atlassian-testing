import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepSessionFiles } from '../src/nodes/browserqa.mjs'

test('sweep: moves fresh NN-*.png / .webm from cwd into outDir, leaves old and unrelated files', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pag-cwd-')), out = fs.mkdtempSync(path.join(os.tmpdir(), 'pag-out-'))
  for (const f of ['01-a.png', 'qa.webm', 'README.md', 'old-9.png']) fs.writeFileSync(path.join(cwd, f), 'x')
  fs.writeFileSync(path.join(cwd, '09-old.png'), 'x'); fs.utimesSync(path.join(cwd, '09-old.png'), 1, 1)
  const moved = sweepSessionFiles(cwd, out, Date.now() - 60_000)
  assert.equal(moved, 2)
  assert.deepEqual(fs.readdirSync(out).sort(), ['01-a.png', 'qa.webm'])
  assert.deepEqual(fs.readdirSync(cwd).sort(), ['09-old.png', 'README.md', 'old-9.png'])
})
