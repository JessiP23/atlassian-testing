// The path guard. Every case here is a run that actually failed or nearly leaked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, isDenied, isScratch, isTestFor, overBudget, DIFF_LIMITS } from '../src/lib/guard.mjs'

test('the .env class is denied — this is the one that would have pushed five live credentials', () => {
  for (const p of ['.env', '.env.local', 'app/.env.production', '.npmrc', 'certs/server.pem', 'id_rsa']) {
    assert.equal(isDenied(p), true, `${p} should be denied`)
  }
})

test('an agent may not edit its own source or its own CI', () => {
  assert.equal(isDenied('agent/graph/src/nodes/patch.mjs'), true)
  assert.equal(isDenied('.github/workflows/agent-ticket-to-pr.yml'), true)
  assert.equal(isDenied('package-lock.json'), true)
})

test('the agent\'s OUTPUT is scratch, not a denied edit — the KAN-6 last-step refusal', () => {
  // `agent/runs/**` matches DENY's `^agent/`, so a perfectly correct patch was refused
  // `touched_denied_path` because Playwright had written screenshots there.
  for (const p of ['agent/runs/KAN-6/x/evidence/pw-before/x.png', 'test-results/x/trace.zip', 'playwright-report/index.html', '.pag/escalate.txt']) {
    assert.equal(isScratch(p), true, `${p} should be filtered out as scratch`)
  }
  assert.equal(isScratch('agent/graph/src/nodes/patch.mjs'), false, 'agent SOURCE is not scratch')
})

test('a test beside an allowed source is in scope however the planner spelled it', () => {
  assert.equal(isTestFor('app/Thing.test.tsx', ['app/Thing.tsx']), true)
  assert.equal(isTestFor('app/__tests__/Thing.test.tsx', ['app/Thing.tsx']), true)
  assert.equal(isTestFor('app/Other.test.tsx', ['app/Thing.tsx']), false)
})

test('classify separates the fatal from the judgement call', () => {
  const v = classify(
    ['app/page.tsx', 'app/page.repro.test.tsx', '.env', 'app/unrelated.ts'],
    ['app/page.tsx'],
    ['app/page.repro.test.tsx'],
  )
  assert.deepEqual(v.denied, ['.env'])
  assert.deepEqual(v.outOfScope, ['app/unrelated.ts'])
  assert.deepEqual(v.inScope.sort(), ['app/page.repro.test.tsx', 'app/page.tsx'])
  assert.equal(v.ok, false)
})

test('the committed witness is in scope, so the evidence is not reported as scope creep', () => {
  const v = classify(['app/page.tsx', 'e2e/KAN-6.pag.spec.mjs', 'e2e/pag-fixtures.mjs'],
    ['app/page.tsx'], ['e2e/KAN-6.pag.spec.mjs', 'e2e/pag-fixtures.mjs'])
  assert.deepEqual(v.outOfScope, [])
  assert.equal(v.ok, true)
})

test('a bug fix that rewrites the repo is not a bug fix', () => {
  assert.deepEqual(overBudget({ files: 3, insertions: 40, deletions: 10 }), [])
  assert.equal(overBudget({ files: DIFF_LIMITS.maxFiles + 1, insertions: 0, deletions: 0 }).length, 1)
  assert.equal(overBudget({ files: 1, insertions: DIFF_LIMITS.maxLines, deletions: 1 }).length, 1)
})
