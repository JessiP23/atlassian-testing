import test from 'node:test'
import assert from 'node:assert/strict'
import { scanRedFlags, isTestPath } from '../src/lib/redflags.mjs'

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,7 @@ export function f(x: Foo) {
   const keep = 1
-  const old = (x as any).y
+  const fresh = (x as any).y
+  // @ts-ignore legacy
+  const n: any = 2
+  // TODO: remove
   return keep
diff --git a/src/__tests__/a.test.ts b/src/__tests__/a.test.ts
--- a/src/__tests__/a.test.ts
+++ b/src/__tests__/a.test.ts
@@ -1,2 +1,3 @@
+const schema = {} as unknown as Schema
 test('x', () => {})
`

test('flags only ADDED product lines, with the right line numbers; removed lines and tests do not count', () => {
  const found = scanRedFlags(diff)
  assert.deepEqual(found.map((f) => [f.file, f.line, f.kind]), [
    ['src/a.ts', 11, 'as any'],
    ['src/a.ts', 12, '@ts-ignore'],
    ['src/a.ts', 13, ': any'],
    ['src/a.ts', 14, 'TODO/FIXME'],
  ])
})

test('NEW FILE bodies are scanned as all-added; the frozen repro spec is exempt by path and by name', () => {
  const body = `\n--- NEW FILE: src/new.ts\nexport const a = 1\nconst b = x as unknown as Y\n\n--- NEW FILE: src/x.repro.test.ts\nconst s = {} as any\n\n--- NEW FILE: src/exempt.ts\nconst e = 1 as any\n`
  const found = scanRedFlags(body, { exempt: ['src/exempt.ts'] })
  assert.deepEqual(found.map((f) => [f.file, f.line, f.kind]), [['src/new.ts', 2, 'as unknown as']])
})

test('words that merely contain the tokens are not flagged', () => {
  const ok = `--- a/s.ts\n+++ b/s.ts\n@@ -1,1 +1,3 @@\n+const company = 'Anyway'\n+const many: Many = f()\n+console.error('kept')\n`
  assert.deepEqual(scanRedFlags(ok), [])
  assert.equal(isTestPath('packages/x/src/__tests__/y.ts'), true)
  assert.equal(isTestPath('packages/x/src/y.ts'), false)
})
