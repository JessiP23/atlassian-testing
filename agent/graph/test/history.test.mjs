import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { recentCommits, historyBlock } from '../src/lib/history.mjs'

test('recentCommits reads per-file git history, newest first, and tolerates unknown files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '-q'); fs.writeFileSync(path.join(dir, 'a.ts'), '1'); git('add', '.'); git('commit', '-qm', 'first: add a')
  fs.writeFileSync(path.join(dir, 'a.ts'), '2'); git('commit', '-qam', 'second: change a')
  const out = await recentCommits(dir, ['a.ts', 'missing.ts'])
  assert.equal(out.length, 2)
  assert.match(out[0].commits[0], /^[0-9a-f]{7} \d{4}-\d{2}-\d{2} second: change a$/)
  assert.match(out[0].commits[1], /first: add a$/)
  assert.deepEqual(out[1].commits, [])
})

test('historyBlock states empty results instead of hiding them', () => {
  const md = historyBlock({ commits: [{ file: 'x.ts', commits: [] }], related: { tickets: [], error: 'HTTP 401' } })
  assert.match(md, /x\.ts:\n  \(no history/)
  assert.match(md, /Related tickets: none found \(search failed: HTTP 401\)\./)
  const md2 = historyBlock({ commits: [], related: { tickets: [{ key: 'ESI2-1712', status: 'Done', summary: 'Restore deleted fields' }] } })
  assert.match(md2, /ESI2-1712 \[Done\] Restore deleted fields/)
  assert.match(md2, /DIFFERENT cause is a hypothesis/)
})
