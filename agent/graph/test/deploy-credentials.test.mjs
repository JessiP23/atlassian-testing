import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ciDeployCredentials, deployEnv, versionIdFor, AGENT_VERSION_ID } from '../src/nodes/deploy.mjs'

// Phase C: the deploy runs in CI on credentials the workflow mints (OIDC -> panda-agent-deploy ->
// ap-cicd-cross-account-deployment). They arrive under PAG_DEPLOY_AWS_* so they never shadow the
// Bedrock role the same job holds — a plain AWS_ACCESS_KEY_ID here would send Claude's calls to the
// dev account and every model call would fail.

test('CI credentials are read only from the PAG_DEPLOY_AWS_* names', () => {
  assert.equal(ciDeployCredentials({}), null)
  assert.equal(ciDeployCredentials({ AWS_ACCESS_KEY_ID: 'AKIA…', AWS_SECRET_ACCESS_KEY: 's' }), null, 'the job\'s Bedrock credentials are never used for a deploy')
  const c = ciDeployCredentials({ PAG_DEPLOY_AWS_ACCESS_KEY_ID: 'AKIA1', PAG_DEPLOY_AWS_SECRET_ACCESS_KEY: 's1', PAG_DEPLOY_AWS_SESSION_TOKEN: 't1', PAG_DEPLOY_AWS_ARN: 'arn:aws:sts::362202801688:assumed-role/x/y' })
  assert.deepEqual(c, { AWS_ACCESS_KEY_ID: 'AKIA1', AWS_SECRET_ACCESS_KEY: 's1', AWS_SESSION_TOKEN: 't1', arn: 'arn:aws:sts::362202801688:assumed-role/x/y' })
})

test('a half-set of credentials is no credentials', () => {
  assert.equal(ciDeployCredentials({ PAG_DEPLOY_AWS_ACCESS_KEY_ID: 'AKIA1' }), null)
})

test('the deploy env comes from PAG_DEPLOY_ENV in CI and .env.local on a laptop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pag-'))
  const file = path.join(dir, '.env.local')
  fs.writeFileSync(file, '# dev\nHOSTED_ZONE=dev.example.com\nAWS_ACCOUNT="362202801688"\n')

  const local = deployEnv(file, {})
  assert.equal(local.values.HOSTED_ZONE, 'dev.example.com')
  assert.equal(local.values.AWS_ACCOUNT, '362202801688')
  assert.equal(local.source, file)

  const ci = deployEnv(file, { PAG_DEPLOY_ENV: 'HOSTED_ZONE=dev.example.com\nAWS_ACCOUNT=362202801688' })
  assert.equal(ci.values.AWS_ACCOUNT, '362202801688')
  assert.match(ci.source, /PAG_DEPLOY_ENV/)

  assert.equal(deployEnv(path.join(dir, 'nope'), {}), null, 'no file and no variable is a skip, not a guess')
})

test('the backend version is the one warm backend unless a run overrides it', () => {
  delete process.env.PAG_BACKEND_VERSION_ID
  assert.equal(versionIdFor('ESI2-1'), AGENT_VERSION_ID)
  process.env.PAG_BACKEND_VERSION_ID = 'abc12345'
  assert.equal(versionIdFor('ESI2-1'), 'abc12345')
  delete process.env.PAG_BACKEND_VERSION_ID
})
