# Architecture — TEST-0

## Ticket restatement

The ticket summary is "Fix the thing" and the full description is "It is broken, please fix it."
There are no acceptance criteria, no scope-in items, no scope-out items, no constraints, no
labels, and no hinted files. The reporter and assignee are both unset. The Jira status is
already `Done`. The only recorded ambiguity is that no explicit acceptance criteria were
provided.

Nothing in the brief identifies *what* "the thing" is, *what* "broken" means, which user or
caller is affected, or how a fix would be recognised as correct.

## Approach

None. There is no smallest change to choose, because the brief names no subject and no defect.

Per architecture hard rule 3 ("If the ticket is ambiguous, list questions in `open_questions`
and set `ready_for_dev: false` rather than guessing") and orchestrator hard rule 6 ("If the
ticket cannot be turned into a faithful brief, stop"), this run stops at architecture. The
transcription is faithful — the *source ticket* is the thing that is unusable, not the
transcription of it.

Before blocking, I verified against this checkout that the repository is not in a broken state
that a fix could reasonably be inferred to target:

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | clean, 0 vulnerabilities |
| Lint | `npm run lint` | pass, no findings |
| Production build (includes TypeScript) | `npm run build` | pass, compiled in 4.3s, 4/4 static pages generated |
| Routes built | — | `/` and `/_not-found`, both static |

So there is no observable failure in this checkout to anchor an inferred fix to.

One item is worth flagging to a human but is **not** a defect and is **not** being changed:
`app/layout.tsx:20` types its props as `LayoutProps<"/">`. A bare `npx tsc --noEmit` on a
clean clone reports `TS2304: Cannot find name 'LayoutProps'`, because that global is emitted
into `.next/types` by `next dev` / `next build` and does not exist before the first build.
`npm run build` passes, which is the repo's actual TypeScript gate. This is stock Next.js 16
`create-next-app` behaviour, not the ticket's "thing", and guessing that it is would be
inventing an acceptance criterion.

## Touchpoints

- `app/page.tsx` — leave — stock scaffold, renders, nothing in the brief points here.
- `app/layout.tsx` — leave — builds and renders; see the `LayoutProps` note above.
- `app/globals.css` — leave — nothing in the brief points here.
- `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs` — leave — all
  green.
- `.github/agents/**`, `.github/workflows/**` — leave — orchestrator hard rule 5; this ticket
  is not about the agents.

## Data and APIs

No contract, schema, or compatibility change is implied by the brief.

## Risks

The risk here is of acting, not of holding. Any code change made in response to this brief
would be an invented requirement: it would land unreviewable product behaviour under a Jira
key that authorises none, and it would make the pipeline look like it satisfied a ticket that
was never specified. A blocked run is the honest outcome.

## Open questions

These need answers in Jira before development can start:

1. What is "the thing"? Name the page, route, component, script, or workflow.
2. What is the observed broken behaviour — error message, wrong output, or visual defect?
3. What is the expected behaviour instead? This becomes the acceptance criterion.
4. How is it reproduced? URL, steps, environment, browser.
5. Which environment shows it — local `next dev`, a preview deploy, or production?
6. The Jira status is already `Done`. Was this ticket closed already, or is it a pipeline
   smoke-test ticket that should not produce product code at all?

## Ready for design

no
