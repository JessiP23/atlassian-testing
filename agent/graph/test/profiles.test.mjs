// The profile layer is what makes this repo-agnostic: moving to another codebase is a profile plus
// two env values, not a fork. These are the invariants the graph relies on, checked for EVERY
// profile so adding one cannot silently break the scheduler.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import nextjs from '../profiles/nextjs.mjs'
import nx from '../profiles/nx.mjs'
import { loadProfile } from '../profiles/index.mjs'

const PROFILES = { nextjs, nx }

test('every profile answers the whole contract', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    for (const k of ['name', 'isUi', 'ownerOf', 'typeConsumersFor', 'gate', 'testOne', 'entryPoints', 'app']) {
      assert.ok(p[k] !== undefined, `${name} is missing ${k}`)
    }
    assert.equal(typeof p.app.argv, 'function', `${name}.app.argv must build the start command`)
  }
})

test('loadProfile fills in capabilities a profile does not declare', () => {
  // Added `e2eDir` after both profiles existed; a missing capability must default, not throw.
  const p = loadProfile(process.cwd())
  assert.equal(typeof p.e2eDir, 'function')
})

test('build is exclusive and optional in every profile', () => {
  // Exclusive because it writes the same build dir the witness\'s dev server is reading; optional
  // because under a tight clock the run reports "build skipped" rather than missing the deadline.
  // verify.mjs schedules on these two flags, so a profile that forgets them serialises the gate
  // or corrupts a dev server.
  const plans = [
    nextjs.gate(process.cwd(), { owners: ['app'], typeConsumers: [] }),
    nx.gate(process.cwd(), { owners: ['a'], typeConsumers: ['b'] }),
  ]
  for (const plan of plans) {
    const build = plan.find((c) => c.target === 'build')
    if (!build) continue
    assert.equal(build.exclusive, true, 'build must run alone')
    assert.equal(build.optional, true, 'build must be droppable at the deadline')
  }
})

test('lint and typecheck are concurrent-safe (nothing else is exclusive)', () => {
  const plan = nx.gate(process.cwd(), { owners: ['a'], typeConsumers: [] })
  for (const c of plan.filter((x) => x.target !== 'build')) {
    assert.notEqual(c.exclusive, true, `${c.target} must be runnable concurrently`)
  }
})

test('the nextjs profile does not pretend to have a test runner it lacks', () => {
  // Returning a fake command here is how you get a repro step that "fails for harness reasons"
  // forever. null means "no unit rung", and reproduce climbs to the browser witness instead.
  assert.equal(nextjs.testOne('/definitely/not/a/repo', 'x.test.ts'), null)
})
