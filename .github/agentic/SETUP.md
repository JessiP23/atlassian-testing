# Jira → GitHub → Amazon Bedrock → review-only PR

This repository implements a Jira-triggered coding pipeline. Jira is the trigger, GitHub Actions is the orchestrator, Amazon Bedrock is the model host, and a human always merges.

Inference is **not** GitHub Copilot. Ticket transcription, routing, architecture, design, and first-pass quality use **Bedrock Haiku**. Implementation and hard edge cases use **Bedrock Opus**. Pins live in [models.yml](models.yml).

```
Jira status → Ready for Dev
        ↓
Jira Global Automation (Send web request)
        ↓
GitHub repository_dispatch  event_type: jira-ready-for-dev
        ↓
Checkout latest default branch
        ↓
Haiku transcribes the ticket verbatim
        ↓
Build a compact codebase index from this checkout
        ↓
Unique branch  agent/<issue-key>/<run-id>
        ↓
Opus implements via agents in .github/agents/
        ↓
gh pr create   labels: agent-pr, needs-human-review
        ↓
STOP. No merge. No auto-merge.
```

Agent files (source of behavior):

| File | Model | Job |
| --- | --- | --- |
| `orchestrator.agent.md` | Haiku | Route the run, refuse vague tickets |
| `agentic_workflows.agent.md` | Haiku | Workflows, webhook contract, index |
| `architecture.agent.md` | Haiku | Where the change belongs |
| `design.agent.md` | Haiku | Behavior and contracts |
| `development.agent.md` | Opus | Code on the run branch |
| `quality.agent.md` | Haiku, Opus on escalation | Ticket fidelity and safety |

The executable workflow is [jira-to-pr.yml](../workflows/jira-to-pr.yml). [jira-to-pr.md](../workflows/jira-to-pr.md) is the GitHub Agentic Workflow spec. Do not `gh aw compile` that markdown while the YAML runner exists, or both will fire on the same Jira event.

---

## 1. Amazon Bedrock

1. In AWS, open Amazon Bedrock → Model catalog and enable Claude **Haiku** and Claude **Opus** (submit the use-case form once per account).
2. Use **cross-region inference profile** IDs (`us.anthropic...`), not base model IDs. Match [models.yml](models.yml) or override with GitHub Actions variables `BEDROCK_HAIKU_MODEL` and `BEDROCK_OPUS_MODEL`.
3. Create a GitHub OIDC identity provider: URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
4. Create an IAM role trusted by that provider. Limit `sub` to `repo:<owner>/<repo>:*`. Attach [iam-bedrock-policy.json](iam-bedrock-policy.json).
5. Copy the role ARN. You will store it as `AWS_ROLE_TO_ASSUME`.

Trust policy sketch:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:*" }
      }
    }
  ]
}
```

---

## 2. GitHub

### Secrets (Settings → Secrets and variables → Actions)

| Secret | Required | Purpose |
| --- | --- | --- |
| `AWS_ROLE_TO_ASSUME` | Yes | IAM role ARN for Bedrock via OIDC |
| `APP_ID` | Recommended | GitHub App ID so the agent PR still triggers CI |
| `APP_PRIVATE_KEY` | Recommended | GitHub App private key |
| `JIRA_BASE_URL` | Optional | e.g. `https://your-site.atlassian.net` |
| `JIRA_EMAIL` | Optional | Atlassian account email for the API token |
| `JIRA_API_TOKEN` | Optional | Atlassian API token; comments the PR URL on the ticket |

`GITHUB_TOKEN` can open the PR, but GitHub will **not** run CI on that PR. A GitHub App (Contents, Issues, Pull requests: read/write; webhooks disabled) avoids that.

### Variables (optional)

| Variable | Default |
| --- | --- |
| `AWS_REGION` | `us-east-1` |
| `BEDROCK_HAIKU_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `BEDROCK_OPUS_MODEL` | `us.anthropic.claude-opus-4-8` |

### Token for Jira to call GitHub

Create a fine-grained PAT **or** GitHub App installation token with `contents: write` on this repo. Store it in Jira as a secret. This is what Jira sends as `Authorization: Bearer ...` to `repository_dispatch`. The token owner must have write access to the repo.

### Branch protection on `main`

- Require a pull request.
- Require at least one human review.
- Do **not** allow GitHub Actions to bypass pull request rules for this pipeline.
- Do **not** add a merge queue rule that auto-merges `agent-pr` labels.

### Enable Actions

Settings → Actions → Allow GitHub Actions. After the first push of these workflow files, confirm `Jira to PR` appears under the Actions tab.

---

## 3. Jira (Atlassian)

Use **Global automation** (or project automation) so every project can share one rule.

1. Jira → Settings → **System** → **Global automation** → Create rule.
2. **Trigger:** Issue transitioned.
   - Destination status: `Ready for Dev` (create this status on the workflow if it does not exist).
3. **Condition (recommended):** Issue type is Story, Bug, or Task. Skip Epics.
4. **Condition (recommended):** Description is not empty.
5. **Action:** Send web request.

| Field | Value |
| --- | --- |
| URL | `https://api.github.com/repos/<OWNER>/<REPO>/dispatches` |
| HTTP method | POST |
| Web request body | Custom data |
| Headers | `Accept: application/vnd.github+json` |
| Headers | `Authorization: Bearer <JIRA_SECRET_GITHUB_TOKEN>` |
| Headers | `Content-Type: application/json` |
| Headers | `X-GitHub-Api-Version: 2022-11-28` |

Custom data (smart values **must** use `.jsonEncode` so descriptions do not break JSON):

```json
{
  "event_type": "jira-ready-for-dev",
  "client_payload": {
    "issue_key": {{issue.key.jsonEncode}},
    "summary": {{issue.summary.jsonEncode}},
    "description": {{issue.description.jsonEncode}},
    "issue_type": {{issue.issueType.name.jsonEncode}},
    "priority": {{issue.priority.name.jsonEncode}},
    "status": {{issue.status.name.jsonEncode}},
    "issue_url": {{issue.url.jsonEncode}},
    "acceptance_criteria": {{issue.customfield_10000.jsonEncode}},
    "labels": {{issue.labels.jsonEncode}},
    "assignee": {{issue.assignee.displayName.jsonEncode}},
    "reporter": {{issue.reporter.displayName.jsonEncode}},
    "parent_key": {{issue.parent.key.jsonEncode}}
  }
}
```

Replace `customfield_10000` with your Acceptance Criteria field id, or delete that line.

6. Check **Delay execution** off. Turn the rule **on**.
7. Optional second action: add a Jira comment “Handed to GitHub agent” so reporters see the handoff even before the PR exists.

Loop prevention: GitHub may later comment on the Jira issue. That comment must **not** transition status and must **not** re-trigger this rule. Trigger only on transition **into** `Ready for Dev`.

---

## 4. End-to-end test

### A. Manual GitHub test (no Jira yet)

1. Merge or push this branch so the workflow file is on the default branch. `workflow_dispatch` and `repository_dispatch` only run from the default branch.
2. Actions → **Jira to PR** → Run workflow.
3. Fill a real, small ticket: summary, a description with acceptance criteria, a key such as `TEST-1`.
4. Confirm AWS OIDC works (no `Not authorized to perform sts:AssumeRoleWithWebIdentity`).
5. Confirm Haiku wrote `.github/agentic/run/ticket-brief.md` on the agent branch with **verbatim** summary/description.
6. Confirm a PR opened against `main`, labels `agent-pr` and `needs-human-review`, auto-merge **off**.
7. Confirm nobody merged it.

### B. Dispatch test (simulates Jira)

Replace the token, owner, and repo:

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${GITHUB_DISPATCH_TOKEN}" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/<OWNER>/<REPO>/dispatches \
  -d '{
    "event_type": "jira-ready-for-dev",
    "client_payload": {
      "issue_key": "TEST-1",
      "summary": "Add a test heading to the home page",
      "description": "On the home page, show a heading that says Pipeline ready.\n\nAcceptance:\n- The heading is visible\n- Existing layout still works",
      "issue_type": "Task",
      "priority": "Medium",
      "status": "Ready for Dev",
      "issue_url": "https://example.atlassian.net/browse/TEST-1"
    }
  }'
```

### C. Real Jira test

1. Create a small issue with a clear description and acceptance criteria.
2. Move it to **Ready for Dev**.
3. Jira automation audit log should show HTTP 204 from GitHub.
4. GitHub Actions run starts within a few seconds.
5. PR appears; Jira gets a comment with the PR URL if Jira secrets are set.

If the ticket is vague, the pipeline still opens a **blocked** PR that contains the brief and ambiguities. It will not invent a feature.

---

## How agents stay current

- **Every run checks out the current default branch.** Agents never plan against a stale clone you stored in the prompt.
- **Agent files live in git.** Change an agent through a normal PR. The next Jira run loads the new profile from `main`.
- **Live index:** `prepare` rebuilds `.github/agentic/run/codebase-index.md` from that checkout (capped map, not a source dump).
- **Snapshot index:** on push to `main`, `refresh-codebase-index.yml` opens a review-only PR if `.github/agentic/codebase-index.md` changed. Humans merge that. The live index still wins at runtime.

Do not paste the whole repo into agent markdown. Search the checkout.

---

## Tradeoffs

**Large codebases.** Haiku cannot read the tree. The index is a map; Opus then greps and opens files. Cost and quality stay acceptable until the relevant module is huge or poorly named. Next step is path allowlists in the ticket (`files_hint`) or a retrieval service, not a bigger prompt.

**Keeping agents up to date.** Profiles are process, not product knowledge. Product knowledge comes from `main` at run start. If you bake “the app has three routes” into an agent file, it will rot. Put durable conventions in agent files; put structure in the generated index.

**Every merge.** The refresh workflow proposes an index PR. That is extra PR noise. You can ignore those PRs; runtime indexing still happens. Turning refresh into a direct commit to `main` would skip review and is disabled on purpose.

**Haiku vs Opus.** Haiku is cheap and good at extraction and routing. It will miss subtle architecture. Opus is expensive and slow but can code. The split is the cost control. If Haiku architecture plans are weak, set the architecture agent to escalate more aggressively, or pin architecture to Opus in `models.yml` and the architecture agent frontmatter.

**GitHub Agentic Workflows vs this YAML.** gh-aw gives sandboxing and safe-outputs, but its first-class engines are Copilot/Claude API/Codex/Gemini, not Bedrock. Claude Code on Bedrock is wired here with OIDC. The `.md` spec is ready if you later compile gh-aw and drop the YAML.

**No auto-merge.** You trade latency for review. Agents will open wrong PRs. Branch protection is the real backstop; the workflow only refuses to merge.

**CI on agent PRs.** `GITHUB_TOKEN` pushes do not trigger workflows. Use a GitHub App (`APP_ID` / `APP_PRIVATE_KEY`) so lint/test still run on the agent PR.

**Secrets in Jira payloads.** `repository_dispatch` `client_payload` is visible in the Actions UI. Do not put API tokens in the Jira ticket body. The transcriber copies the description verbatim into the PR.

**Concurrency.** Two transitions of the same ticket create two branches and two PRs (`run-id` in the branch name). Close the stale one. Concurrency does not cancel in-progress runs.

**Dispatch payload size.** GitHub `client_payload` is small (on the order of tens of kilobytes). Huge Jira descriptions will fail the webhook. Keep implementation tickets tight, or have Jira send the key only and add a later step that fetches the issue via the Jira REST API.

**Next.js.** `AGENTS.md` / `CLAUDE.md` in the repo root are generated by `next dev`. Development still must read `node_modules/next/dist/docs/` before using Next APIs.
