import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentBranchPattern } from '../src/nodes/publish.mjs'

test('supersede: matches only this ticket\'s agent branches, every rerun suffix, no other ticket', () => {
  const p = agentBranchPattern('ESI2-3194', 'agent/')
  for (const b of ['agent/ESI2-3194-fix', 'agent/ESI2-3194-fix-r11', 'agent/ESI2-3194-hotfix-r2']) assert.ok(p.test(b), b)
  for (const b of ['agent/ESI2-31940-fix', 'agent/ESI2-3193-fix', 'agent/ESI2-3194-fix-r11-human', 'feature/ESI2-3194-fix', 'ESI2-3194-fix']) assert.ok(!p.test(b), b)
})
