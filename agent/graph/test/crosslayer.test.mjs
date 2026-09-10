import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crossLayerTerms } from '../src/nodes/locate.mjs'

test('crossLayerTerms reads the operations, hooks and shared types a UI file calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-'))
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ui', 'ChangedBy.tsx'), `
import { ActivityLogEntry, ChangedByProps } from '@pioneer/activity/types'
import { useGetActivityLogsQuery } from '../generated'
const q = gql\`query GetActivityLogs($id: ID!) { getActivityLogs(id: $id) { changedBy ipAddress } }\`
export const ChangedBy = () => { const { data } = useGetActivityLogsQuery(); return data?.getActivityLogs }
`)
  const terms = crossLayerTerms(dir, ['ui/ChangedBy.tsx', 'ui/missing.tsx'])
  for (const t of ['GetActivityLogs', 'getActivityLogs', 'ActivityLogEntry', 'ChangedByProps']) assert.ok(terms.includes(t), `missing ${t} in ${terms}`)
})

import { conceptStems, conceptSeeds } from '../src/nodes/locate.mjs'
import { execFileSync } from 'node:child_process'

test('conceptStems turns the plan\'s questions into grep-able stems; conceptSeeds finds the files that mention them', async () => {
  const stems = conceptStems('The metadata-indexer lambda must detect employee impersonation. How is employee impersonation recorded? Is the impersonated user identified? Can Summary of Changes display "Asset Panda Employee"')
  assert.ok(stems.includes('impersonat'), stems.join(','))
  assert.ok(!stems.includes('configurat'), 'stopwords are dropped')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '-q')
  fs.mkdirSync(path.join(dir, 'src', '__tests__'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'auth.ts'), 'export const impersonate = () => 1\n// Impersonation header\nconst isImpersonated = true\n')
  fs.writeFileSync(path.join(dir, 'src', 'other.ts'), 'export const x = 1\n')
  fs.writeFileSync(path.join(dir, 'src', '__tests__', 'auth.test.ts'), 'impersonate()\n')
  git('add', '.'); git('commit', '-qm', 'x')
  const seeds = await conceptSeeds(dir, ['impersonat'])
  assert.deepEqual(seeds.map((x) => x.path), ['src/auth.ts'])
  assert.match(seeds[0].why, /mentions impersonat ×3/)
})
