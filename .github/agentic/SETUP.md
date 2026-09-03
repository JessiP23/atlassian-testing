# Setup checklist (access keys, not OIDC)

You already have AWS access keys, a GitHub PAT, and Jira API credentials. **Skip GitHub OIDC.** Put the AWS keys in GitHub. Put the GitHub PAT in Jira. Put the Jira credentials in GitHub.

Repo used below: [JessiP23/atlassian-testing](https://github.com/JessiP23/atlassian-testing).

---

## Two secrets, two places (read this first)

| Secret | Where it lives | Why |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | **GitHub** Actions secrets | The workflow calls Amazon Bedrock |
| GitHub PAT | **Jira** automation (hidden header) | Jira calls GitHub to start the workflow |
| `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_API_TOKEN` | **GitHub** Actions secrets | After the PR opens, GitHub comments the PR link on the Jira ticket |

Those are three different credentials. Do not put AWS keys in Jira. Do not put the Jira API token in the Jira webhook body.

---

## Step 1 — AWS: confirm Bedrock and attach IAM to the user that owns the keys

OIDC is a way for GitHub to log into AWS **without** access keys. You already have keys, so you are not doing OIDC.

### 1a. Open the IAM user that created the keys

1. Open [IAM users](https://console.aws.amazon.com/iam/home#/users).
2. Click the **user name** those keys belong to (not the root account if you can avoid it).
3. Confirm the keys exist under **Security credentials** → **Access keys**.

### 1b. Give that user Bedrock permission

1. On that same user, open the **Permissions** tab.
2. **Add permissions** → **Create inline policy** → **JSON**.
3. Paste the JSON from [iam-bedrock-policy.json](iam-bedrock-policy.json).
4. Name it `BedrockClaudeInvoke` → **Create policy**.

That policy lets this user invoke Haiku and Opus, including `us.anthropic.claude-opus-5`.

### 1c. Enable Anthropic models in Bedrock (once per account)

1. Open Bedrock in `us-east-1`: [Model catalog](https://us-east-1.console.aws.amazon.com/bedrock/home?region=us-east-1#/model-catalog).
2. Search **Claude Haiku 4.5**. Open it. If AWS asks for a first-time Anthropic use-case form, submit it (company/site can be a GitHub profile URL).
3. Search **Claude Opus 5**. Open it / open it in the playground once so the Marketplace subscription can complete (can take a few minutes).

Your model IDs:

- Haiku: `us.anthropic.claude-haiku-4-5-20251001-v1:0`
- Opus: `us.anthropic.claude-opus-5`

The `us.` prefix is a **US cross-region inference profile**. Run the GitHub workflow with `AWS_REGION=us-east-1` unless you already use another US Bedrock region.

Official docs: [Request access to Bedrock models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).

---

## Step 2 — GitHub: store secrets and variables

Open: [https://github.com/JessiP23/atlassian-testing/settings/secrets/actions](https://github.com/JessiP23/atlassian-testing/settings/secrets/actions)

**Secrets** tab → **New repository secret** for each:

| Name | Value |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | your access key id |
| `AWS_SECRET_ACCESS_KEY` | your secret access key |
| `JIRA_BASE_URL` | `https://YOUR-SITE.atlassian.net` (no trailing slash) |
| `JIRA_EMAIL` | the Atlassian email that created the Jira API token |
| `JIRA_API_TOKEN` | the Jira API token you already have |

Do **not** put the GitHub PAT here. That one goes in Jira in step 4.

Open: [https://github.com/JessiP23/atlassian-testing/settings/variables/actions](https://github.com/JessiP23/atlassian-testing/settings/variables/actions)

**Variables** tab → **New repository variable**:

| Name | Value |
| --- | --- |
| `AWS_REGION` | `us-east-1` |
| `BEDROCK_HAIKU_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `BEDROCK_OPUS_MODEL` | `us.anthropic.claude-opus-5` |

Official docs: [Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).

### Enable Actions if needed

[https://github.com/JessiP23/atlassian-testing/settings/actions](https://github.com/JessiP23/atlassian-testing/settings/actions)

Allow GitHub Actions / Allow all actions.

The workflow files must be **on `main`**. Push/merge this branch first. `workflow_dispatch` and `repository_dispatch` only run from the default branch.

---

## Step 3 — GitHub: protect `main` (this is GitHub, not Jira)

Open: [https://github.com/JessiP23/atlassian-testing/settings/branches](https://github.com/JessiP23/atlassian-testing/settings/branches)

1. **Add classic branch protection rule**.
2. Branch name pattern: `main`
3. Check **Require a pull request before merging**.
4. Check **Require approvals** → `1`.
5. Leave **Allow specified actors to bypass required pull requests** unchecked.
6. Check **Do not allow bypassing the above settings** if you see it.
7. **Create**.

That is the whole “protect main” step. It lives only on GitHub. Jira cannot protect `main`.

Official docs: [Managing a branch protection rule](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule).

On GitHub Free personal repos, some org-only options are missing. Requiring a pull request is enough to stop the agent from merging into `main` by pushing directly. The workflow also never runs `gh pr merge`.

---

## Step 4 — Jira: store the GitHub PAT and send the webhook

Your Jira email + token already exist. You create those at [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Those three values (`base url`, email, token) go in **GitHub** (step 2). They are not the GitHub PAT.

The GitHub PAT is what Jira uses to hit GitHub’s API. Jira has **no** GitHub-secrets page. You paste it into the automation rule as a **hidden Authorization header**.

### 4a. Confirm the PAT can dispatch

The PAT needs permission to create a `repository_dispatch` on `JessiP23/atlassian-testing`.

- Classic PAT: `repo` scope.
- Fine-grained PAT: Resource owner `JessiP23`, repository `atlassian-testing`, permission **Contents: Read and write**.

Create/check classic tokens: [https://github.com/settings/tokens](https://github.com/settings/tokens)  
Fine-grained: [https://github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)

### 4b. Open automation

Replace `YOUR-SITE` with the hostname from `JIRA_BASE_URL`.

- **Global** (all projects): `https://YOUR-SITE.atlassian.net/jira/settings/automation`  
  You must be a Jira admin. Gear (⚙️) top right → **System** → **Global automation**.
- **One project:** open the project → **Project settings** → **Automation**.  
  Example path: `https://YOUR-SITE.atlassian.net/jira/software/projects/KEY/settings/automation`

Official actions reference (includes Send web request + Hidden values): [Jira automation actions](https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/).

### 4c. Create the rule

1. **Create rule**.
2. Trigger: **Work item transitioned** (sometimes still labeled **Issue transitioned**).
   - To status: `Ready for Dev`  
   - If you do not have that status, pick the status you actually use (for example `Selected for Development`) and use that everywhere. Do not invent a status you cannot transition to.
3. Action: **Send web request**.

Fill:

| Field | Value |
| --- | --- |
| URL | `https://api.github.com/repos/JessiP23/atlassian-testing/dispatches` |
| HTTP method | POST |
| Web request body | Custom data |
| Wait for response | No |

**Headers** (add all four):

| Header | Value | Hidden |
| --- | --- | --- |
| `Accept` | `application/vnd.github+json` | no |
| `Content-Type` | `application/json` | no |
| `X-GitHub-Api-Version` | `2022-11-28` | no |
| `Authorization` | `Bearer PASTE_THE_GITHUB_PAT_HERE` | **yes — check Hidden** |

Hidden is how Jira stores the PAT. After you save, you will only see `*****`. That is expected.

**Custom data.** `.jsonEncode` escapes the text but does **not** add the quotes, so each smart value must sit inside `"..."`. Without the quotes Jira's editor rejects the body with `Unable to parse fields due to invalid JSON`, because it validates the template before substituting values.

```json
{
  "event_type": "jira-ready-for-dev",
  "client_payload": {
    "issue_key": "{{issue.key}}",
    "summary": "{{issue.summary.jsonEncode}}",
    "description": "{{issue.description.jsonEncode}}",
    "issue_type": "{{issue.issueType.name.jsonEncode}}",
    "priority": "{{issue.priority.name.jsonEncode}}",
    "status": "{{issue.status.name.jsonEncode}}",
    "issue_url": "{{issue.url}}"
  }
}
```

Quoting also makes empty fields safe: a missing priority renders as `""` instead of breaking the JSON.

Do not use `.asJsonString` here. That function adds its own quotes, so combining it with `"..."` produces `""value""` and GitHub returns 422.

4. Turn the rule **On**. Name it `GitHub: Ready for Dev → agent PR`.

---

## Step 5 — Test in this order

### A. GitHub only (no Jira)

1. Confirm the workflow file is on `main`.
2. Open [Actions](https://github.com/JessiP23/atlassian-testing/actions).
3. Click **Jira to PR** → **Run workflow**.
4. Fill a tiny ticket (one heading change, one acceptance line).
5. The run must: assume AWS with your keys, call Haiku, open a PR, **not** merge.

If AWS fails, the log will say `UnrecognizedClientException` (bad keys) or `AccessDeniedException` (IAM / model access). Fix step 1, do not touch Jira yet.

### B. Simulate Jira with curl (still no Jira UI)

```bash
curl -i -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer PASTE_THE_GITHUB_PAT_HERE" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/JessiP23/atlassian-testing/dispatches \
  -d '{"event_type":"jira-ready-for-dev","client_payload":{"issue_key":"TEST-1","summary":"Add a test heading to the home page","description":"Show a heading that says Pipeline ready.\n\nAcceptance:\n- Heading is visible","issue_type":"Task","priority":"Medium","status":"Ready for Dev","issue_url":"https://example.atlassian.net/browse/TEST-1"}}'
```

Success is **HTTP 204** and an empty body. Then check Actions.

**401** = bad PAT. **404** = PAT cannot see the repo or the repo name is wrong. **422** = JSON body invalid.

### C. Real Jira

1. Create a small work item with a real description.
2. Transition it to the status from step 4c.
3. In the automation rule, open **Audit log**. You want GitHub status **204**.
4. GitHub Actions starts. A PR opens. If Jira secrets in GitHub are set, the ticket gets a comment with the PR URL.

---

## Troubleshooting

### `Unable to parse fields due to invalid JSON` in Jira custom data

Jira validates the JSON template before it substitutes smart values, so a bare `{{issue.key.jsonEncode}}` is not valid JSON at edit time. `.jsonEncode` escapes the contents of a string, it does not produce the string. Wrap every smart value in quotes: `"{{issue.summary.jsonEncode}}"`. See the corrected body in step 4c.

### `Unrecognized named-value: 'secrets'` in a workflow file

The `secrets` context is not available in a step-level `if:`. GitHub's [contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability) lists only `github, needs, strategy, matrix, job, runner, env, vars, steps, inputs` for `jobs.<job_id>.steps.if`. `jobs.<job_id>.env` *does* allow `secrets`, so promote the test to a job-level env var and branch on that:

```yaml
jobs:
  refresh:
    runs-on: ubuntu-latest
    env:
      HAS_GITHUB_APP: ${{ secrets.APP_ID != '' }}
    steps:
      - if: env.HAS_GITHUB_APP == 'true'
        uses: actions/create-github-app-token@v2
```

Note the negative case is written `!= 'true'` rather than `== 'false'`, so an unset secret still takes the fallback path.

### Jira audit log says 204 but no run appears

`repository_dispatch` only ever runs the workflow file as it exists on the **default branch**. If `jira-to-pr.yml` is still on a feature branch, or the file is invalid YAML, GitHub accepts the dispatch and silently does nothing. Check [Actions](https://github.com/JessiP23/atlassian-testing/actions) for a red "Invalid workflow file" banner.

### `Jira auth preflight: HTTP 401` in the "Comment result on Jira" job

The PR was opened; only the Jira comment failed. A 401 from **both** the site URL and `api.atlassian.com` means Jira rejected the email + token pair itself, not the URL. Fix it in this order, and validate with the 10-second check workflow instead of a full Bedrock run.

1. **Create a fresh token**, and prefer the classic kind. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) → **Create API token** (not "Create API token with scopes"). Copy it immediately; it is shown once.
2. **Use the email of the account that created the token.** It is shown at [id.atlassian.com/manage-profile/email](https://id.atlassian.com/manage-profile/email). A Google-login account and a password account with the same person behind them are different accounts.
3. **Re-enter all three secrets** at [github.com/JessiP23/atlassian-testing/settings/secrets/actions](https://github.com/JessiP23/atlassian-testing/settings/secrets/actions). Paste into a plain-text editor first and delete any trailing newline or space. `JIRA_BASE_URL` is the bare site, e.g. `https://your-site.atlassian.net`, with no `/jira` or project path.
4. **Run the check**: [Actions → Jira connection check → Run workflow](https://github.com/JessiP23/atlassian-testing/actions/workflows/jira-connection-check.yml). Enter a real issue key such as `KAN-1`. A pass prints `Jira auth OK as <name> <email>` and `Issue KAN-1 is visible`. It also reports the character length of each secret and flags leading/trailing whitespace, without printing the values.
5. Then **re-run only the failed job** on the last pipeline run (Actions → the run → "Re-run failed jobs"). The comment job checks out `main`, so it picks up the current script without a new ticket.

To test the pair from your own machine first:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -u 'you@example.com:YOUR_TOKEN' \
  https://your-site.atlassian.net/rest/api/2/myself
```

`200` = good. `401` = wrong email/token, or an **expired** token (every token now has an expiry chosen at creation; the tokens page shows it). If you did create a scoped token, it will only return `200` through `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/2/myself` and needs `read:jira-work` and `write:jira-work` (plus `read:jira-user` for `/myself` itself); the script tries that gateway automatically and falls back to reading the issue when `/myself` is out of scope.

---

## What you can ignore

- **GitHub OIDC / IAM identity provider / AWS_ROLE_TO_ASSUME** — only needed if you later delete the access keys. Skip it.
- **APP_ID / APP_PRIVATE_KEY** — optional. Without them, GitHub will not run CI on the agent PR (`GITHUB_TOKEN` pushes do not trigger workflows). You can add a GitHub App later.
- **Compiling** `.github/workflows/jira-to-pr.md` with `gh aw` — the YAML runner is what executes.

---

## If you later want OIDC instead of keys

That is GitHub logging into AWS with a short-lived token instead of storing `AWS_ACCESS_KEY_ID`. Steps: [Configure OIDC in Amazon Web Services](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services). Provider URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, then an IAM **role** (not a user) that this repo can assume. You do not need that today.
