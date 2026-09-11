# Panda Agent — Jira ticket to draft PR, with proof

A LangGraph pipeline that turns an ESI2 ticket into **draft** PRs on `AssetPandaLLC/pioneer`
(`main` + a `qa` copy) whose body carries a test that failed before the patch and passes after it,
browser screenshots, and a ledger of what is proven, inferred and not verified. Nothing merges: the
PRs are drafts and the agent's token cannot merge — that is the human's role.

```
label PandaAgentGraph ─▶ pioneer-poll.yml (10 min) ─┐
Jira Automation (instant, Phase B) ────────────────┴─▶ repository_dispatch pioneer-ticket
                                                          │
   container ghcr.io/jessip23/panda-agent:$PAG_IMAGE_TAG  ▼   OIDC ─▶ panda-agent-gha (Bedrock, S3)
intake ─▶ plan ─▶ locate ─▶ reproduce ─▶ patch ─▶ verify ─▶ deploy ─▶ browserqa ─▶ approve ─▶ publish
  │        │ ▲      │  ▲       │            ▲        │  (skips until Phase C)              │
  │        │ └widen─┘  └replan─┘            └repair≤3┘                                    ▼
  └────────┴──────────────── refuse (needs_data · not_a_bug · replan_budget_exhausted) ─▶ Jira comment
```

| node | model | what it does |
|---|---|---|
| `intake` | Haiku | ticket + screenshots → spec (symptom, steps, risk notes), or refuse |
| `plan` | Haiku | competing hypotheses (`test`/`browser`/`data` checks), git + Jira history, ≤5 production files; escalates to a wider locate ≤2× |
| `locate` | $0 + Haiku | BM25 router over the index → import hops → cross-layer terms + concept stems (`git grep`) → symptom-text seeds |
| `reproduce` | Opus | ONE failing test on the base commit (frozen by sha256), ≤2 runs, verdict per hypothesis (`REPRO: red H2 ruled-out: H1`). No red test and no testable explanation left → refuse `needs_data` |
| `patch` | Opus | Claude Code, allowlist only, git denied at the tool layer; must write `### Root cause / ### Why this fix / ### Review first` |
| `verify` | $0 | frozen test green; lint/test/build for the owning nx projects; baseline on demand when a failure is unattributable; red-flag scan (`any`, `@ts-ignore`, `eslint-disable`, `console.log`, TODO) |
| `repair` | Opus | ≤3 attempts on the gate output; an `.pag/escalate.txt` is believed the first time |
| `deploy` | $0 | pushes the patch's Lambdas onto the agent's own backend version so QA can show the fix working — **skips in CI until the dev-account role exists (Phase C)** |
| `browserqa` | Opus | headed Chromium on Xvfb against the local app + qa backend: `verify` mode (UI fix) or `observe` mode (backend fix, $2.50 / 6 min cap) |
| `publish` | Haiku | two draft PRs (create-or-update, never over a human commit), proof ledger, "For the reviewer", Jira comment + transition |

Every run writes `runs/<KEY>/<timestamp>/` (node JSON, `timeline.md`, `stream.log`, `patch.diff`,
`evidence/`) and one row to `metrics.csv`; CI syncs them to `s3://assetpanda-agent-runs/{runs,evidence,metrics}/`
and restores `runs/<KEY>/` at the start of the next run of the same ticket (its red test is reused for $0).

## Running it

From Jira: add the label `PandaAgentGraph` to an ESI2 ticket. Rerun = remove and re-add the label.

From a laptop, against the image built from the commit you are on:

```bash
agent/graph/bin/try.sh [--dry-run] ESI2-1234 [ESI2-1235 …]   # waits for the edge build, dispatches with image_tag=edge
```

Fully local (your own worktree, your own .env):

```bash
npm --prefix agent/graph ci
cp agent/graph/.env.example agent/graph/.env                    # fill in
node agent/graph/bin/prepare-worktree.mjs --repo ~/pioneer-agent --from ~/pioneer --base main
node agent/graph/bin/run.mjs ESI2-1234 --repo ~/pioneer-agent --dry-run
```

## Release

`main` is integration. `build-image.yml` builds `:edge` on every push to main; a tag `vX.Y.Z` builds
`:vX.Y.Z`. The repo variable `PAG_IMAGE_TAG` is production — label-triggered runs use it, and
rollback is moving that variable. A manual run can pass `image_tag` for itself only.

## Infra (`agent/infra/`)

* `aws-gha.sh` — OIDC provider, role `panda-agent-gha` (Bedrock invoke + the runs bucket), bucket
  `assetpanda-agent-runs`, monthly budget with an automatic kill switch (`BUDGET_USD`, default 1500).
  Rerun it to change any of those.
* `aws-deploy-role.sh` — run ONCE in the dev account by someone with IAM admin: role
  `panda-agent-deploy`, trusted by the same OIDC identity, allowed only to assume
  `ap-cicd-cross-account-deployment`. Unblocks `deploy`.

## Guards, all mechanical

Allowlist of files per run · git mutations denied inside Claude Code · frozen repro test (hash) ·
diff scanned for credentials · one remote (`PAG_ALLOWED_REMOTE`), branch prefix `agent/`, draft PRs
only · cost cap per run (`PAG_CAP_USD`) and one clock sliced per phase · never force-pushes over a
human commit · runs only against qa/dev backends.

Repo-specific code lives only in `agent/graph/profiles/` (`nx.mjs` for pioneer).
