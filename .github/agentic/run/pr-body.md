## TEST-0 — blocked: ticket not implementable as written

- **Jira key:** TEST-0
- **Jira URL:** https://example.atlassian.net/browse/TEST-0
- **Branch:** `agent/test-0/33774330508`
- **Result:** no product code changed — the pipeline stopped at architecture.

### Verbatim summary

> Fix the thing

### Verbatim description

> It is broken, please fix it.

### What changed

**Nothing.** No product code was written and no commit was added to this branch.

The ticket names no subject and no defect. It carries zero acceptance criteria, zero scope-in
items, zero scope-out items, zero constraints, and zero hinted files; the reporter and assignee
are unset. Implementing anything would have meant inventing the requirement first, which the
pipeline rules forbid (architecture hard rule 3, design hard rule 1, development hard rule 8).

Before blocking, the run verified that this checkout is not in a failing state that an inferred
fix could plausibly target:

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | Clean, 150 packages, 0 vulnerabilities |
| Lint | `npm run lint` | Pass, no findings |
| Build + TypeScript | `npm run build` | Pass — compiled in 4.3s, 4/4 static pages, routes `/` and `/_not-found` |

So "it is broken" does not correspond to any observable failure in this repository.

Run artifacts (`architecture.md`, `design.md`, `development.md`, `quality.md`, `handoff.json`)
were written under `.github/agentic/run/`, which is gitignored — they are workflow outputs, not
committed files.

### What TEST-0 needs before it can be re-run

1. What is "the thing"? Name the page, route, component, script, or workflow.
2. What is the observed broken behaviour — error message, wrong output, or visual defect?
3. What is the expected behaviour instead? This becomes the acceptance criterion.
4. How is it reproduced? URL, steps, environment, browser.
5. Which environment shows it — local `next dev`, a preview deploy, or production?
6. The Jira status is already **Done**. Was this ticket closed already, or is it a pipeline
   smoke-test ticket that should not produce product code at all?

### How to test

There is no behaviour change to test. To confirm the branch is inert and the base is healthy:

```bash
git diff main...HEAD        # expected: empty
npm ci
npm run lint               # expected: pass
npm run build              # expected: pass, 4/4 static pages
```

### Residual risks / quality leftover

- **No risk introduced by this run.** The branch is byte-identical to its base commit.
- **TEST-0 is still unfixed**, because it is still unspecified. The residual risk sits on the
  ticket, not the code.
- **Pipeline nit, flagged not changed:** `ticket-brief.json` shipped `ready_for_dev: true` for a
  brief with an empty description-derived `acceptance_criteria` array. The transcription
  contract says an unusable ticket should be marked `ready_for_dev: false`. Worth reviewing
  `.github/agentic/scripts/transcribe_ticket.py`. Left alone here because this ticket is not
  about the pipeline.
- **Pre-existing scaffold nit, flagged not changed:** `app/layout.tsx:20` types props as
  `LayoutProps<"/">`. A bare `npx tsc --noEmit` on a never-built clone reports
  `TS2304: Cannot find name 'LayoutProps'`, because `next dev` / `next build` emit that global
  into `.next/types`. `npm run build` passes, so the repo's actual TypeScript gate is green.
  This is stock Next.js 16 `create-next-app` behaviour and was deliberately not "fixed" — doing
  so would have been an invented acceptance criterion.
- The repo has **no test runner**. None was added, per the rule against inventing a framework.
  This will need resolving for the first real ticket.

---

Do not merge until a human reviews.
