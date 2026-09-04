# Roadmap

Status of the ticket→PR agent in this repo, in the order things were proven. Each line is a
mechanism, not an intention: "done" means a real run exercised it.

## Done and exercised in CI

| # | Mechanism | Proven by |
|---|---|---|
| 1 | Jira → `repository_dispatch` → one workflow (`agent-ticket-to-pr.yml`) | KAN-5/KAN-6 runs; three workflows used to fire on one ticket |
| 2 | Scoped Jira tokens via the `api.atlassian.com` gateway; `/myself` is not a gate | KAN-6 intake, $0.004 |
| 3 | Context tree built per run from the checkout (index + history) | `index: 5 file(s)` |
| 4 | Retrieval: phrase seeds from on-screen text → BM25 → import hop → entry points | KAN-6 located `app/page.tsx`, `app/layout.tsx` |
| 5 | Plan as a mechanical allowlist (≤5 production files) | KAN-6 named 4 files |
| 6 | Witness: Playwright spec written before the fix, proven RED against the running app | KAN-6, 146s, $0.50 |
| 7 | Patch: Claude Code inside the allowlist, git denied at the tool layer | KAN-6, 188s, $0.89, witness went green |
| 8 | Bedrock 503 = wait, not error: real backoff + `us.`→`global.`→bare profile walk | stubbed-client test, recovered on attempt 5 |
| 9 | A node that throws is a refusal with a timeline, not a stack trace | `ci.mjs` catch |

## Next, in order

1. **Close KAN-6.** The witness output landed inside the repo (`agent/graph/witness/pw-out/`), which
   is a DENIED path, so a correct run was refused at the last step. Output now goes to the run
   folder or the OS temp dir, and agent scratch is filtered out of the diff before the guard sees
   it. Re-run to get the first draft PR with paired before/after images.
2. **State-by-state evidence.** `check(page, 'NN-state', …)` asserts softly and screenshots the
   state it judged, so the red run walks the whole flow instead of dying on criterion 1. The PR
   pairs the two runs BY NAME and says plainly which states the broken build never reached.
3. **Measure over ~10 tickets:** how many land `evidence:e2e` / `evidence:repro` / `evidence:none`,
   wall time, cost per ticket. That table decides everything below it.
4. **Unit rung for this repo** — add vitest so a non-UI ticket has a rung besides the browser
   (`profiles/nextjs.mjs → testOne` already detects jest/vitest and will start using it).
5. **Cheap tier** — `PAG_CHEAP_NODES=intake,rerank,plan,package` on `us.openai.gpt-5.6-luna`
   ($0.44/$1.98 vs Haiku's $1/$5). Bench the rerank before trusting it; it is the one that moves
   hit@5.
6. **Port back to Pioneer.** `PAG_PROFILE=nx` + `PAG_ALLOWED_REMOTE=AssetPandaLLC/pioneer`. The
   graph does not change; what changes is the profile and the fact that Pioneer has a real test
   runner, so the unit rung carries most tickets and the witness is for the web client only.
7. **Jira write-back** — comment the PR link and the evidence label on the ticket (the code path
   exists in `refuse`; extend it to `publish`).

## Deliberately not doing yet

- **A vision model judging screenshots.** The verdict stays a Playwright assertion that was red
  before and green after. A model's opinion of a picture is a guess again; the picture is for the
  human. A caption model can come later as annotation, never as the gate.
- **Per-branch backend deploys** (Cody's `deploy:version`, 15–30 min). Not on the critical path
  until a backend ticket actually needs a browser to prove itself.
- **Merging.** Never. The PR is a draft and the token cannot merge.
