# Ticket brief — KAN-1

## Identity
- Key: `KAN-1`
- Type: Task
- Priority: Medium
- Status: In Progress
- URL: https://jessisworkspace-31653410.atlassian.net/browse/KAN-1
- Assignee: n/a
- Reporter: n/a
- Labels: none
- Ready for dev: True

## Verbatim summary
Replace starter home page with a pipeline status page and health endpoint

## Verbatim description
Replace the create-next-app boilerplate on the home page with a simple status page that confirms the Jira-to-PR pipeline works end to end.

Home page (app/page.tsx):

* A top-level heading that reads exactly: Pipeline ready
* Below the heading, a short line: Jira → GitHub Actions → Pull request
* A list of three pipeline stages, each showing a name and a "Connected" badge:
*# Jira automation
*# GitHub Actions
*# Pull request review
* Remove the Next.js logo, the "To get started" text, and the Deploy Now / Documentation / Templates / Learning links.
* Keep the existing Tailwind styling approach and keep dark mode working.

Health endpoint:

* Add GET /api/health that returns HTTP 200 with JSON: { "status": "ok", "service": "atlassian-testing" }
* No authentication, no database, no external calls.

Constraints:

* Do not add any new npm dependencies.
* The page must stay a static server component (no client-side fetching, no "use client").
* Do not modify app/layout.tsx or globals.css unless required.

Acceptance criteria:

* Visiting / shows an h1 with the exact text "Pipeline ready".
* The three stage names and three "Connected" badges are visible.
* None of the boilerplate links or the Next.js logo remain on the page.
* curl [http://localhost:3000/api/health|http://localhost:3000/api/health] returns status 200 and the exact JSON above.
* npm run lint and npm run build both pass with no errors.

## Acceptance criteria
- None

## Scope in
- None

## Scope out
- None

## Constraints
- None

## Ambiguities
- No explicit acceptance criteria were provided.

## Files hinted by the ticket
- None
