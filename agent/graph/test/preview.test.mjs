import test from 'node:test'
import assert from 'node:assert/strict'
import { deepLink, subdomainFor, entryFor, AUTH_TYPE } from '../src/lib/preview.mjs'
import { previewBlock } from '../src/nodes/preview.mjs'

// The link is the evidence a non-developer can check. It must pin the backend itself — if the
// reviewer has to pick one in the Env Switcher, half of them will pick the wrong one and conclude
// the fix does not work.

const qa = { versionId: 'qa', branch: 'qa', developer: 'Shared Account', url: 'https://qa.appsync-api.us-east-1.amazonaws.com/graphql', userPoolId: 'us-east-1_QA', userPoolWebClientId: 'qaclient', domainKey: 'qadomain' }
const agent = { versionId: '238f0e42', branch: 'agent/ESI2-3441-fix', developer: 'panda-agent', url: 'https://agent.appsync-api.us-east-1.amazonaws.com/graphql', userPoolId: 'us-east-1_AG', userPoolWebClientId: 'agclient', domainKey: 'agdomain' }

test('the deep link carries every field /login reads, apiKey included (it is the domainKey)', () => {
  const u = new URL(deepLink('https://esi2-3441.preview.example.com', agent))
  assert.equal(u.pathname, '/login')
  assert.equal(u.searchParams.get('graphqlEndpoint'), agent.url)
  assert.equal(u.searchParams.get('userPoolId'), 'us-east-1_AG')
  assert.equal(u.searchParams.get('userPoolWebClientId'), 'agclient')
  assert.equal(u.searchParams.get('apiKey'), 'agdomain', 'the client reads apiKey as the domain key — EnvSwitcher does the same')
  assert.equal(u.searchParams.get('domainKey'), 'agdomain')
  assert.equal(u.searchParams.get('authenticationType'), AUTH_TYPE)
})

test('no link is built from an incomplete registry entry', () => {
  assert.equal(deepLink('https://x.example.com', { url: 'https://a' }), null)
  assert.equal(deepLink(null, agent), null)
})

test('the subdomain is stable and DNS-safe, so a link survives a rerun', () => {
  assert.equal(subdomainFor('ESI2-3441'), 'esi2-3441')
  assert.equal(subdomainFor('ESI2-3441'), subdomainFor('ESI2-3441'))
  assert.equal(subdomainFor('ESI2-3441', 'before'), 'esi2-3441-before')
})

test('a version id wins over a branch of the same name', async () => {
  assert.equal((await entryFor('238f0e42', [qa, agent])).versionId, '238f0e42')
  assert.equal((await entryFor('qa', [qa, agent])).branch, 'qa')
  assert.equal(await entryFor('nope', [qa, agent]), null)
})

test('a backend fix changes ONLY the backend between the two links', () => {
  const md = previewBlock({
    spec: { acceptanceCriteria: ['Submit the form', 'Open the related record'] },
    preview: { status: 'ready', layer: 'backend', origin: 'https://esi2-3441.preview.example.com',
      after: { url: deepLink('https://esi2-3441.preview.example.com', agent), versionId: '238f0e42' },
      before: { url: deepLink('https://esi2-3441.preview.example.com', qa), branch: 'qa' } },
  })
  assert.match(md, /## See it yourself/)
  assert.match(md, /same frontend build/)
  assert.match(md, /238f0e42/)
  assert.ok(md.includes('1. Submit the form'))
})

test('no link and no block when the backend fix was never deployed', () => {
  assert.equal(previewBlock({ preview: { status: 'skipped', reason: 'deploy did not run' } }), '')
  assert.equal(previewBlock({}), '')
})
