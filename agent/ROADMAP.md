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
| 10 | State-by-state evidence: soft `check()`, screenshots named, PR table paired BY NAME | KAN-6: 8 red → 8 green + GIF, first draft PR |
| 11 | Content scan of the ADDED diff lines — a credential in an allowed file is a refusal | `test/secrets.test.mjs`, 9 cases incl. the false-positive set |
| 12 | Gate output parsed to `{file,line,rule,message}` before repair is paid for | `test/gatelog.test.mjs`, 9 real output shapes |
| 13 | One deadline, sliced per phase, with publish always reserved | `test/budget.test.mjs`, 11 cases |
| 14 | Out of clock with a diff = INCOMPLETE draft PR, not a deleted branch | `test/routing.test.mjs`, the KAN-6 case pinned |
| 15 | Re-running a ticket is safe: create-or-update the PR, never force over a human commit | `remoteBranchOwner` + `createOrUpdatePr` |
| 16 | The PR link is written back onto the Jira ticket on SUCCESS, not only on refusal | `publish.mjs` |
| 17 | Baseline, app boot and the gate all run concurrently with the phases that don't need them | `snap.setPending` / `warmApp` / `Promise.all` |
| 18 | 57 self-tests over the deterministic parts, run in CI before a model is paid for | `npm --prefix agent/graph test` |

## Next, in order

1. **Run T1–T5** (`agent/TICKETS-HARD.md`) and fill in the table below. That measurement decides
   everything under it, and nothing under it should be built before the table exists.

   | Ticket | Evidence label | Wall time | Cost | Repairs | Outcome | Would you merge it? |
   |---|---|---|---|---|---|---|
   | T1 filter + URL state | | | | | | |
   | T2 API route + optimistic UI | | | | | | |
   | T3 dialog focus trap | | | | | | |
   | T4 misattributed footer | | | | | | |
   | T5 paginated list (sized to hit the diff cap) | | | | | | |

   T4 is deliberately wrong about where the bug is: the finding is whether it escalates with
   `NEED:` instead of guessing. T5 is sized to hit `DIFF_LIMITS` — whether it lands, escalates or
   refuses on size is the finding. **Do not raise the caps before seeing which.**

2. **Unit rung for this repo** — add vitest so a non-UI ticket has a rung besides the browser
   (`profiles/nextjs.mjs → testOne` already detects jest/vitest and will start using it). This is
   also what makes `e2eDir` non-null here, so the witness spec starts shipping inside the diff.
3. **Cheap tier** — `PAG_CHEAP_NODES=intake,rerank,plan,package` on `us.openai.gpt-5.6-luna`
   ($0.44/$1.98 vs Haiku's $1/$5). Bench the rerank before trusting it; it is the one that moves
   hit@5. It cannot hold `patch`/`repair`/`repro` — no tool use — and `models.mjs` throws if you try.
4. **Port back to Pioneer.** `PAG_PROFILE=nx` + `PAG_ALLOWED_REMOTE=AssetPandaLLC/pioneer`. The
   graph does not change; what changes is the profile and the fact that Pioneer has a real test
   runner, so the unit rung carries most tickets and the witness is for the web client only.
5. **Then, only if the T1–T5 table says so:** more repair attempts, a wider diff cap, or a second
   re-plan. Each of those is a number, and each one should be moved by evidence from a run, not by
   a hunch about what "should" work.

## Known limits, stated on purpose

- **`build` is droppable.** Under a tight clock the gate skips it and the PR says so in the
  Evidence section. `tsc --noEmit` covers most of what it would catch, and CI on the PR runs the
  full gate. It is a disclosed gap, not a silent one.
- **A hand-over bypasses `PAG_REQUIRE_APPROVAL`.** An incomplete draft is already labelled
  `agent:incomplete` and titled `[INCOMPLETE]`, and a human has to finish it either way.
- **The witness spec only ships in the diff where the repo has `@playwright/test`**
  (`profile.e2eDir`). Elsewhere it reaches the reviewer inlined in the PR body and on the evidence
  branch — a spec that cannot run in the repo it lands in is worse than no spec.
- **Only the first source target gets a reproducing test.** A ticket whose symptom needs two files
  to reproduce gets one rung and honest `evidence:none` on the other.

## Deliberately not doing yet

- **A vision model judging screenshots.** The verdict stays a Playwright assertion that was red
  before and green after. A model's opinion of a picture is a guess again; the picture is for the
  human. A caption model can come later as annotation, never as the gate.
- **Per-branch backend deploys** (Cody's `deploy:version`, 15–30 min). Not on the critical path
  until a backend ticket actually needs a browser to prove itself.
- **Merging.** Never. The PR is a draft and the token cannot merge.
