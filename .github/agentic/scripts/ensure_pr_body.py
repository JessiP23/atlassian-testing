#!/usr/bin/env python3
"""Write a fallback PR body when the coding agent did not produce one."""

from __future__ import annotations

import os
from pathlib import Path


def main() -> None:
    path = Path(os.environ.get("PR_BODY_FILE", ".github/agentic/run/pr-body.md"))
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return
    key = os.environ.get("ISSUE_KEY", "UNKNOWN")
    summary = os.environ.get("SUMMARY", "")
    path.write_text(
        f"## {key}\n\n{summary}\n\n"
        "Agent-generated changes from the Jira-to-PR pipeline.\n\n"
        "Do not merge until a human reviews.\n"
    )


if __name__ == "__main__":
    main()
