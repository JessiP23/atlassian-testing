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
