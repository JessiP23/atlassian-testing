// What repair is handed. Every shape here is real output copied from a run of this workflow —
// including the nx `project: ` prefix, which is why the first version of excerpt() showed stack
// traces instead of assertions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGateFailures, formatFailures, summariseFailures } from '../src/lib/gatelog.mjs'

test('eslint stylish', () => {
  const out = `
./app/components/ThemeToggle.tsx
  14:6  error  React Hook "useEffect" has a missing dependency: 'theme'  react-hooks/exhaustive-deps
  22:1  warning  Unexpected console statement  no-console

✖ 2 problems (1 error, 1 warning)
`
  const f = parseGateFailures(out, 'lint')
  assert.equal(f.length, 1, 'warnings must not be reported as failures')
  assert.deepEqual(
    { file: f[0].file, line: f[0].line, rule: f[0].rule },
    { file: 'app/components/ThemeToggle.tsx', line: 14, rule: 'react-hooks/exhaustive-deps' },
  )
})

test('tsc, both spellings', () => {
  const a = parseGateFailures("app/page.tsx(12,5): error TS2322: Type 'string' is not assignable to type 'number'.", 'typecheck')
  assert.equal(a[0].line, 12); assert.equal(a[0].rule, 'TS2322')
  const b = parseGateFailures("app/page.tsx:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.", 'typecheck')
  assert.equal(b[0].line, 12); assert.equal(b[0].file, 'app/page.tsx')
})

test('next build type error, where the location and the message are on different lines', () => {
  const out = `
Failed to compile.

./app/notes/page.tsx:31:9
Type error: Property 'notes' does not exist on type 'Props'.
`
  const f = parseGateFailures(out, 'build')
  assert.equal(f.length, 1)
  assert.equal(f[0].file, 'app/notes/page.tsx')
  assert.equal(f[0].line, 31)
  assert.match(f[0].message, /Property 'notes'/)
})

test('nx prefixes every line and must not blind the parser', () => {
  const out = `clients-web-app: app/page.tsx(9,3): error TS2554: Expected 1 arguments, but got 0.`
  assert.equal(parseGateFailures(out, 'typecheck')[0].line, 9)
})

test('jest failure keeps the assertion, not the stack frame', () => {
  const out = `
● ImportErrorRow › keeps the Asset ID column

  expect(received).toBe(expected)

  Expected: "AP-1042"
  Received: undefined

    at Object.<anonymous> (app/import/ImportErrorRow.test.tsx:22:31)
    at Promise.then.completed (node_modules/jest-circus/build/utils.js:293:28)
`
  const f = parseGateFailures(out, 'test')
  assert.equal(f[0].file, 'app/import/ImportErrorRow.test.tsx')
  assert.equal(f[0].line, 22)
  assert.match(f[0].rule, /keeps the Asset ID column/)
  assert.match(f[0].message, /Expected/)
})

test('the witness soft-assertion form names the state that failed', () => {
  const f = parseGateFailures('[02-after-toggle-dark] expect(received).toHaveCSS: expected rgb(17, 24, 39)', 'repro')
  assert.equal(f[0].rule, '02-after-toggle-dark')
  assert.equal(f[0].tool, 'playwright')
})

test('output with nothing parseable yields nothing rather than nonsense', () => {
  assert.deepEqual(parseGateFailures('Killed\nnpm ERR! code ELIFECYCLE\n', 'build'), [])
})

test('formatFailures groups by file so the edits are obvious', () => {
  const f = [
    { file: 'a.ts', line: 1, rule: 'TS1', message: 'x' },
    { file: 'a.ts', line: 9, rule: 'TS2', message: 'y' },
    { file: 'b.ts', line: 3, rule: 'TS3', message: 'z' },
  ]
  const s = formatFailures(f)
  assert.equal((s.match(/^### /gm) || []).length, 2)
  assert.match(summariseFailures(f), /3 failure\(s\) in 2 file\(s\)/)
})

test('duplicates collapse — the same rule at the same place is one problem', () => {
  const line = './app/x.tsx\n  4:1  error  msg  some-rule\n  4:1  error  msg  some-rule\n'
  assert.equal(parseGateFailures(line, 'lint').length, 1)
})
