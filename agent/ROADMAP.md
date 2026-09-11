# Roadmap

"Done" means a real CI run exercised it. Status as of 2026-09-11.

## Phase A — the agent (done, pinned as `v1.1.0`)

Validated end to end on ESI2-3437, 3265, 3441, 3440, 3439 (PRs #15992–#16003), and on five tickets
run concurrently (11–20 min each, $5–7). Mechanisms: proof ledger, red-flag gate, competing hypotheses,
history, reviewer notes, cross-layer widening, no patch without evidence, baseline on demand, lint
mode detection, nx `testOne`, observe-mode QA cap, run memory in S3, metrics per run.

## Phase B — company-owned trigger and identity (waiting on others)

| step | who | done when |
|---|---|---|
| Jira Automation rule (label → `repository_dispatch pioneer-ticket`) | Cody, or Jessi with ESI2 project-admin | a labelled ticket starts a run in <1 min; then `gh workflow disable pioneer-poll.yml` |
| Jira user "Panda Agent" + API token | Cody | secrets `JIRA_EMAIL`/`JIRA_API_TOKEN` replaced; the next Jira comment is from Panda Agent |
| GitHub App on `pioneer` (Contents + Pull requests: write) | Jessi creates, org owner approves the install | secrets `PIONEER_APP_ID` + `PIONEER_APP_PRIVATE_KEY` set; the workflow mints a per-run token (already wired) and the PR author is `<app>[bot]`; `PIONEER_TOKEN` deleted |
| Bedrock + bucket in the company account | anyone with admin there | `REPO=<org>/<repo> agent/infra/aws-gha.sh` there; `AWS_ROLE_TO_ASSUME` updated; one green run |
| Repo moved into the org | Jessi, last | transfer → rerun `aws-gha.sh` (OIDC subject changes) → rebuild `edge` → retag → one green run |

## Phase C — verified backend fixes (waiting on the dev-account role)

| step | done when |
|---|---|
| `aws-deploy-role.sh` run in dev (362202801688) | ARN of `panda-agent-deploy` printed; repo var `PAG_DEPLOY_ROLE_ARN` set |
| CI credentials for `deploy` | second `configure-aws-credentials` step (role chaining to `ap-cicd-cross-account-deployment`); `deploy.mjs` reads them instead of an SSO session; `.env.local` values come from repo vars |
| one backend per run, not one shared | `AP_VERSION_ID` derived from the ticket key (today it is the single `238f0e42`); parallel backend tickets stop overwriting each other's Lambdas |
| app pointed at the run's backend | `backend.mjs <versionId>` before QA; QA runs in `verify` mode; the PR shows `qa: passed` on a backend ticket |
| teardown | version destroyed when both PRs are closed (extends `agent-pr-merged.yml`) |

## After C

Measure, then change only what the metrics name: `metrics/` in S3 → outcome, `refuse_reason`,
`repairs`, `replans`, `qa_status` per ticket. A failure class becomes a rule in a node only when it
appears on two different tickets. Candidates already known: reading video attachments (transcript),
data-only tickets (`needs_data` → a data-collection comment template), quota raise for >10 parallel.
