import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eslintMode, eslintCommand } from '../src/lib/lint.mjs'

test('legacy .eslintrc repos get ESLINT_USE_FLAT_CONFIG=false in the command; flat and none are recognised', () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'l-')); fs.writeFileSync(path.join(legacy, '.eslintrc.json'), '{}')
  const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'f-')); fs.writeFileSync(path.join(flat, 'eslint.config.mjs'), '')
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'n-'))
  assert.equal(eslintMode(legacy), 'legacy'); assert.equal(eslintMode(flat), 'flat'); assert.equal(eslintMode(none), 'none')
  assert.equal(eslintCommand(legacy, ['a.ts']), 'ESLINT_USE_FLAT_CONFIG=false npx eslint a.ts')
  assert.equal(eslintCommand(flat, ['a.ts']), 'npx eslint a.ts')
  assert.equal(eslintCommand(none), null)
})
