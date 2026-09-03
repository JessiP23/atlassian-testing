---
# GitHub Agentic Workflow source for the Jira-to-PR pipeline.
# Production runner is jira-to-pr.yml (Bedrock + unique branch + review-only PR).
# Compile this file with `gh aw compile` only if you retire jira-to-pr.yml, otherwise
# both would fire on the same Jira dispatch.
on:
  repository_dispatch:
    types: [jira-ready-for-dev]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read
  id-token: write

network:
  allowed:
    - defaults
    - bedrock-runtime.us-east-1.amazonaws.com
    - bedrock.us-east-1.amazonaws.com

engine:
  id: claude
  model: us.anthropic.claude-opus-5
  env:
    CLAUDE_CODE_USE_BEDROCK: "1"
    AWS_REGION: us-east-1
    ANTHROPIC_DEFAULT_HAIKU_MODEL: us.anthropic.claude-haiku-4-5-20251001-v1:0
    ANTHROPIC_DEFAULT_OPUS_MODEL: us.anthropic.claude-opus-5

timeout-minutes: 60
max-turns: 80

tools:
  github:
    toolsets: [default]
  bash:

# Never add merge-pull-request. Humans merge.
safe-outputs:
  create-pull-request:
    title-prefix: "[agent] "
    labels: [agent-pr, needs-human-review]
    draft: false
    max: 1
    if-no-changes: warn
  jira-add-comment:

---

# Jira ticket to review-only pull request

You implement one Jira ticket on a **new unique branch** and request a pull request. You never merge.

## Ticket

- Key: `${{ github.event.client_payload.issue_key }}`
- Summary: `${{ github.event.client_payload.summary }}`
- Type: `${{ github.event.client_payload.issue_type }}`
- Priority: `${{ github.event.client_payload.priority }}`
- Status: `${{ github.event.client_payload.status }}`
- URL: `${{ github.event.client_payload.issue_url }}`
- Description (verbatim): `${{ github.event.client_payload.description }}`

## Agents

Read and follow these profiles in order before you edit product code:

1. `.github/agents/orchestrator.agent.md`
2. `.github/agents/architecture.agent.md`
3. `.github/agents/design.agent.md`
4. `.github/agents/development.agent.md`
5. `.github/agents/quality.agent.md`

Use `.github/agents/agentic_workflows.agent.md` if the ticket is about CI, webhooks, or this pipeline.

## Models

- Haiku on Amazon Bedrock: transcription, routing, architecture, design, first quality pass.
- Opus on Amazon Bedrock: coding and security/edge-case quality.

## Rules

- Start from the default branch checkout of this run. That is the current `main`.
- Copy the Jira summary and description faithfully. Do not invent acceptance criteria.
- Create one branch named `agent/<issue-key-lower>/<unique-suffix>`. Do not reuse branches.
- Do not push to the default branch.
- Do not merge. Do not enable auto-merge. `merge-pull-request` is intentionally absent.
- After quality, request **one** pull request with the Jira key in the title and a body that includes verbatim summary, changes, test plan, residual risks, and `Do not merge until a human reviews.`
- If the ticket is too vague, do not invent a feature. Request no PR and explain the blockers.
