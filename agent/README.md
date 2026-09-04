# agent/ — ticket to PR, with proof

A LangGraph workflow that turns a Jira ticket into a **draft** pull request whose body contains a
test that failed before the patch and passes after it. Deterministic phase boundaries, model work
only inside them, and nothing merges: the PR is a draft and the token cannot merge.

```
intake ─▶ locate ─▶ planning ─▶ reproduce ─▶ patch ─▶ verify ─┬─(green)─▶ approve ─▶ publish ─▶ END
  │         │          │  ▲         │          │  │           │
  │         │          │  └─────────┼──────────┘  │           └─(red, ≤3)──▶ repair ──┐
  │         │          │  re-plan×1 │  (NEED:)    │                                   │
  └─────────┴──────────┴────────────┴─────────────┴──────────────▶ refuse ─▶ END  verify ◀┘
```

| node | model | what it does |
|---|---|---|
| `intake` | Haiku | ticket → spec, or refuse (`not_a_bug`, `underspecified`) |
| `locate` | $0 + Haiku | BM25 over the index → import-graph expansion → 50 candidates → re-rank → ≤4 files |
| `planning` | Haiku | the allowlist: ≤5 production files, steps, tests to write |
| `reproduce` | Opus | **writes ONE test before any code changes**, pass-first then invert, and only accepts it when the runner sees it FAIL on the pinned commit. Frozen by sha256. |
| `patch` | Opus | Claude Code edits only the planned files; every mutating git command is denied at the tool layer |
| `verify` | $0 | the frozen test must now pass (a changed hash is a refusal), then the scoped gate with baseline subtraction |
| `repair` | Opus | ≤3 attempts, sees only the failure |
| `publish` | Haiku | draft PR: `## Evidence` (before/after) and `## How to verify`; `evidence:*` label |

Every node can exit to `refuse`, which comments the reason on the ticket. **Refusing is a
successful outcome** — a ticket that cannot be localised costs about $0.02.

## Two rungs of evidence

1. **Unit** — a jest/vitest test, when the repo has a runner (`profiles/*.testOne`).
2. **Witness** — a Playwright spec against the *running* app: it fails on HEAD, the patch lands,
   the dev server hot-reloads, the same spec passes. Both passes record screenshots, video and a
   trace; ffmpeg makes a ≤10 MB GIF; `publish` embeds before/after images in the PR.

With no `PAG_APP_EMAIL`/`PAG_APP_PASSWORD` the witness is restricted to pages that render without
signing in — which is why the first ticket to try is a visible change on a public page.

A ticket that reproduces on neither rung still gets a PR, labelled `evidence:none`, with the gate
behind it. Roughly half of real issues land there; the label is the reviewer's cue to read harder.

## Profiles — the only repo-specific code

`graph/profiles/<name>.mjs` answers five questions about a codebase: which files are UI, which
project owns a file, what the gate commands are, how to run one test file, and how to start the
app. `PAG_PROFILE` selects one; without it, `nx.json` → `nx`, `next.config.*` → `nextjs`.

Moving this agent to another repo is: copy `agent/`, add a profile, set `PAG_ALLOWED_REMOTE`. The
graph does not change.

## Running it

In CI (`.github/workflows/agent-ticket-to-pr.yml`) — nothing to install locally:

* Actions → *Agent — ticket to PR* → Run workflow → issue key, `dry_run` checked.
* Or transition a ticket in Jira: the existing automation rule's `repository_dispatch` fires it.
* Repo variable `PAG_DRY_RUN=false` makes runs live (branch pushed, draft PR opened).

Locally:

```bash
npm ci && npm --prefix agent/graph install
npx --prefix agent/graph playwright install chromium      # witness rung
cp agent/graph/.env.example agent/graph/.env              # then fill it in
node agent/graph/bin/ci.mjs KAN-1 --repo "$PWD" --dry-run
```

Then read `agent/runs/<KEY>/<runId>/`: `timeline.md`, `pr-body.md`, `patch.diff`, and
`evidence/` (the red and green logs, the screenshots, the GIF).

## Guards, all mechanical

* `guard.mjs` DENY list checked on the **real git diff**: `.env*`, keys, lockfiles, `.github/`,
  `agent/` itself. Anything outside the plan's allowlist is `scope_creep`.
* `DIFF_LIMITS`: 12 files / 400 lines.
* `PAG_ALLOWED_REMOTE`: publish refuses to push anywhere else, and fails closed when unset.
* Budgets in dollars **and** minutes (`PAG_CAP_USD`, `PAG_MAX_MINUTES`); a model session is killed
  when either runs out, with a reserve so `publish` or `refuse` can always report.
* The reproducing test is hashed before `patch` runs; editing it is `repro_tampered`.
