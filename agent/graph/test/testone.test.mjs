import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadProfile } from '../profiles/index.mjs'

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-'))
  fs.writeFileSync(path.join(dir, 'nx.json'), '{}')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"m","devDependencies":{"nx":"1"}}')
  const mk = (p, pj) => { fs.mkdirSync(path.join(dir, p, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, p, 'project.json'), JSON.stringify(pj)) }
  mk('packages/web', { name: 'web', targets: { test: { executor: '@nx/vite:test' } } })
  mk('packages/fn', { name: 'fn', targets: { test: { executor: '@nx/jest:jest' } } })
  return dir
}

test('testOne matches the flag to the executor: vitest gets a positional file, jest gets --testPathPattern', () => {
  const dir = repo()
  const profile = loadProfile(dir)
  const web = profile.testOne(dir, 'packages/web/src/a.repro.test.tsx')
  assert.equal(web.runner, 'vitest')
  assert.ok(web.argv.includes('--testFiles=packages/web/src/a.repro.test.tsx'))
  assert.ok(!web.argv.some((a) => a.startsWith('--testPathPattern')))
  const fn = profile.testOne(dir, 'packages/fn/src/b.repro.test.ts')
  assert.equal(fn.runner, 'jest')
  assert.ok(fn.argv.some((a) => a.startsWith('--testPathPattern=')))
})
