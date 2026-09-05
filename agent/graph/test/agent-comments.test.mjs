import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAgentComment } from '../src/lib/jira.mjs'

const PR_NOTICE = `panda-agent opened a **draft** PR for this ticket.
**https://github.com/AssetPandaLLC/pioneer/pull/15810** -> \`main\`
Gate: green across 1 owning project(s) — lint, test, build`

test("the agent's own PR notice is recognised, whoever's account posted it", () => {
  assert.equal(isAgentComment(PR_NOTICE), true)
})

test('its refusal and hand-over notices too', () => {
  assert.equal(isAgentComment('panda-agent could not finish this one inside its 30-minute budget'), true)
  assert.equal(isAgentComment('panda-agent refused at intake: ticket_underspecified'), true)
})

test('a human root-cause note is never filtered', () => {
  const human = `Root cause: automation-to-automation chaining is blocked by design.
The engine explicitly suppresses those updates (update-collection-record.ts).`
  assert.equal(isAgentComment(human), false)
})

test('a human MENTIONING the agent is not the agent', () => {
  assert.equal(isAgentComment('I think panda-agent is picking the wrong file here — see my PR instead'), false)
})

test('the agent name is configurable', () => {
  assert.equal(isAgentComment('robo opened a draft PR', 'robo'), true)
  assert.equal(isAgentComment('robo opened a draft PR'), false)
})

test('empty and missing bodies are safe', () => {
  assert.equal(isAgentComment(''), false)
  assert.equal(isAgentComment(undefined), false)
})

test('survives being passed straight to Array.filter, which supplies the index', () => {
  const comments = ['panda-agent opened a **draft** PR for this ticket.', 'Root cause: chaining is blocked by design.']
  assert.deepEqual(comments.filter(isAgentComment), ['panda-agent opened a **draft** PR for this ticket.'])
})

test('the refusal notice the graph writes is recognised too (the one that leaked)', () => {
  assert.equal(isAgentComment('panda-agent-graph stopped at `intake`: ticket_reopened\n\nA fix was already shipped'), true)
})

test('the explicit marker wins regardless of wording', () => {
  assert.equal(isAgentComment('<!-- panda-agent -->\nanything at all here'), true)
})

test('a human whose comment merely starts with the agent name is kept', () => {
  assert.equal(isAgentComment('panda-agent picked the wrong file on this one, see my analysis below'), false)
})
