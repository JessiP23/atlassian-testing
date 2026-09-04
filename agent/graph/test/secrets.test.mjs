// The secret scanner has two ways to be useless: miss a credential, or cry wolf. Both are tested,
// and the false-positive half matters more — a scanner that fails correct patches gets switched off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanDiff, scanText } from '../src/lib/secrets.mjs'

const diff = (file, added) => [
  `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
  '@@ -1,3 +1,4 @@', ' const x = 1', ...added.map((l) => `+${l}`), ' export default x',
].join('\n')

test('catches the credential classes that actually leak', () => {
  const cases = {
    'aws-access-key-id': "  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',",
    'github-token': "  const t = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'",
    'slack-token': "  webhook('xoxb-123456789012-abcdefghijkl')",
    'jwt': "  const t = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'",
    'connection-string-password': "  const db = 'postgres://admin:Tr0ub4dor3xK@db.internal:5432/app'",
    'assigned-credential': '  const apiKey = "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c"',
    'private-key': '  const k = `-----BEGIN RSA PRIVATE KEY-----`',
  }
  for (const [kind, line] of Object.entries(cases)) {
    const r = scanDiff(diff('app/lib/client.ts', [line]))
    assert.equal(r.ok, false, `missed ${kind}: ${line}`)
    assert.equal(r.findings[0].kind, kind)
  }
})

test('does not flag how correct code looks', () => {
  const ok = [
    "  const key = process.env.API_KEY",
    "  apiKey: process.env.NEXT_PUBLIC_KEY ?? '',",
    "  password: '',",
    "  password: 'changeme',",
    "  token: '<your-token-here>',",
    "  const secret = `${prefix}-${suffix}`",
    "  await login(page, { password: 'password' })",
    "  className='flex items-center justify-between rounded-lg border px-4'",
    "  const id = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6'  // sha256 of the fixture",
    "  <path d='M4 12a8 8 0 1016 0 8 8 0 10-16 0' />",
  ]
  for (const line of ok) {
    const r = scanDiff(diff('app/page.tsx', [line]))
    assert.equal(r.ok, true, `false positive on: ${line}\n  -> ${JSON.stringify(r.findings)}`)
  }
})

test('a pre-existing secret on a context line is not this run\'s finding', () => {
  const d = [
    'diff --git a/app/x.ts b/app/x.ts', '--- a/app/x.ts', '+++ b/app/x.ts', '@@ -1,3 +1,4 @@',
    "     const k = 'AKIAIOSFODNN7EXAMPLE'",     // context: already in the file
    '+    const y = 2',
  ].join('\n')
  assert.equal(scanDiff(d).ok, true)
})

test('a removed secret is not a finding either', () => {
  const d = [
    'diff --git a/app/x.ts b/app/x.ts', '--- a/app/x.ts', '+++ b/app/x.ts', '@@ -1,3 +1,3 @@',
    "-    const k = 'AKIAIOSFODNN7EXAMPLE'", '+    const k = process.env.AWS_KEY',
  ].join('\n')
  assert.equal(scanDiff(d).ok, true)
})

test('reports the right line number inside the hunk', () => {
  const d = [
    'diff --git a/app/x.ts b/app/x.ts', '--- a/app/x.ts', '+++ b/app/x.ts', '@@ -40,4 +40,6 @@',
    ' a', ' b', "+const k = 'AKIAIOSFODNN7EXAMPLE'", ' c',
  ].join('\n')
  const r = scanDiff(d)
  assert.equal(r.findings[0].line, 42)
  assert.equal(r.findings[0].file, 'app/x.ts')
})

test('never echoes the secret back into the refusal text', () => {
  const r = scanDiff(diff('app/x.ts', ["const k = 'AKIAIOSFODNN7EXAMPLE'"]))
  assert.ok(!r.findings[0].excerpt.includes('AKIAIOSFODNN7EXAMPLE'), 'the excerpt leaked the value')
  assert.match(r.findings[0].excerpt, /<aws-access-key-id>/)
})

test('pag-allow-secret is the reviewable opt-out', () => {
  const r = scanDiff(diff('app/x.ts', ["const k = 'AKIAIOSFODNN7EXAMPLE' // pag-allow-secret: docs sample"]))
  assert.equal(r.ok, true)
})

test('new-file bodies appended by patch.mjs are scanned too', () => {
  const r = scanDiff("--- NEW FILE: app/new.ts\nconst t = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'\n")
  assert.equal(r.ok, false)
  assert.equal(r.findings[0].file, 'app/new.ts')
})

test('scanText is usable on its own', () => {
  assert.equal(scanText('nothing here'), null)
  assert.equal(scanText("secret: 'a-real-looking-secret-value'").kind, 'assigned-credential')
})
