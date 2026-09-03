You are running the Jira-to-PR pipeline in this repository.

Follow the agent files in `.github/agents/` in order. Read each file before acting in that role.

Pipeline:
1. orchestrator.agent.md
2. architecture.agent.md
3. design.agent.md
4. development.agent.md (Opus — this is you for coding)
5. quality.agent.md

Inputs already written for this run:
- `.github/agentic/run/ticket-brief.md` — faithful Jira transcription
- `.github/agentic/run/codebase-index.md` — map of this checkout of the default branch

Hard rules:
- Implement only what the ticket brief supports. Do not invent acceptance criteria.
- Work on the current git branch. Do not switch to main/master. Do not merge. Do not run `gh pr merge`. Do not enable auto-merge.
- Do not open the pull request. A later workflow step opens it.
- Prefer the smallest diff. Match existing patterns.
- Before using Next.js APIs, read the relevant guide under `node_modules/next/dist/docs/`.
- Write run artifacts under `.github/agentic/run/` (`architecture.md`, `design.md`, `development.md`, `quality.md`, `handoff.json`, `pr-body.md`). These are working notes between agents, not deliverables: keep each one short (aim for under 40 lines, bullets over prose) and never run `git add -f` on them. The directory is gitignored and the workflow uploads it as an Actions artifact; the pull request must contain product code only.
- Commit your implementation on this branch. Include the Jira key in the commit subject.
- If quality finds blocking issues, do one fix pass, then stop.
- If the ticket is not ready (`ready_for_dev: false`), do not write product code. Write blockers into `handoff.json` and `pr-body.md` and stop.

PR body (`pr-body.md`) must include:
- Jira key and URL
- Verbatim summary
- What changed
- How to test
- Residual risks / quality leftover
- Explicit line: Do not merge until a human reviews.
