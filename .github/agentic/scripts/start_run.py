#!/usr/bin/env python3
"""Write handoff.json and a blocked PR body at the start of an agent run."""

from __future__ import annotations

import json
import os
from pathlib import Path


def main() -> None:
    run = Path(os.environ.get("RUN_DIR", ".github/agentic/run"))
    run.mkdir(parents=True, exist_ok=True)
    ready = os.environ.get("READY", "false").lower() == "true"
    key = os.environ["ISSUE_KEY"]
    summary = os.environ.get("SUMMARY", "")
    (run / "handoff.json").write_text(
        json.dumps(
            {
                "ticket_key": key,
                "stage": "orchestrator",
                "next_agent": "architecture.agent.md",
                "ready_for_dev": ready,
                "model_used": "haiku",
                "escalated": False,
                "artifacts": [
                    ".github/agentic/run/ticket-brief.md",
                    ".github/agentic/run/codebase-index.md",
                ],
                "blockers": [] if ready else ["Ticket is not ready for implementation."],
            },
            indent=2,
        )
        + "\n"
    )
    if not ready:
        (run / "pr-body.md").write_text(
            f"## {key} — blocked before implementation\n\n"
            f"{summary}\n\n"
            "The orchestrator could not faithfully turn this Jira ticket into implementable work, "
            "so no code was written and no pull request was opened.\n\n"
            "Add a concrete subject, the observed vs expected behaviour, and acceptance criteria, "
            "then transition the ticket again.\n"
        )


if __name__ == "__main__":
    main()
