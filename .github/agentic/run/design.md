# Design — TEST-0

## Behavior

Not specified. `architecture.md` returned `Ready for design: no`, so no behaviour was designed.

Design hard rule 1 is "Stay inside the ticket brief. Do not add features the reporter did not
ask for." The brief ("Fix the thing" / "It is broken, please fix it.") describes no behaviour,
so there is no inside of the brief to stay within. Specifying states — empty, loading, error,
success, authorization failure — would require first inventing the feature those states belong
to.

## Contracts

- Routes / APIs: none specified by the brief.
- Types / props: none specified by the brief.
- Persistence: none specified by the brief.

## Acceptance checks

The brief lists zero acceptance criteria. Per design hard rule 4, this gap is recorded rather
than filled. No testable checks can be derived.

## Out of scope

The brief lists no scope-out items. Treated as out of scope for this run regardless, because
nothing authorises them:

- Any change to `app/page.tsx`, `app/layout.tsx`, or `app/globals.css`.
- The `LayoutProps` / bare-`tsc` note in `architecture.md` — real but not this ticket, and
  `npm run build` passes.
- Any change to `.github/agents/**` or `.github/workflows/**`.
- Adding a test runner. The repo has none, and inventing one is not a fix for an unnamed defect.

## Open questions

Same six as `architecture.md` — the blocker is the ticket text, and design cannot resolve it by
reading more of this checkout. Escalating this stage to Opus would not help either: the missing
information is in Jira, not in the repository.
