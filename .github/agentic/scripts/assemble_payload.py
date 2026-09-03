#!/usr/bin/env python3
"""Turn a GitHub event into JIRA_PAYLOAD_JSON for the transcriber."""

from __future__ import annotations

import json
import os
from pathlib import Path


def payload() -> dict:
    if os.environ.get("EVENT_NAME") == "repository_dispatch":
        data = json.loads(os.environ.get("CLIENT_PAYLOAD") or "{}")
        if not isinstance(data, dict):
            raise SystemExit("repository_dispatch client_payload must be a JSON object")
        return data
    return {
        "issue_key": os.environ.get("INPUT_ISSUE_KEY", ""),
        "summary": os.environ.get("INPUT_SUMMARY", ""),
        "description": os.environ.get("INPUT_DESCRIPTION", ""),
        "issue_type": os.environ.get("INPUT_ISSUE_TYPE", "Task"),
        "priority": os.environ.get("INPUT_PRIORITY", "Medium"),
        "status": os.environ.get("INPUT_STATUS", "Ready for Dev"),
        "issue_url": os.environ.get("INPUT_ISSUE_URL", ""),
        "acceptance_criteria": os.environ.get("INPUT_ACCEPTANCE_CRITERIA", ""),
    }


def main() -> None:
    data = payload()
    github_env = Path(os.environ["GITHUB_ENV"])
    encoded = json.dumps(data)
    with github_env.open("a", encoding="utf-8") as handle:
        handle.write("JIRA_PAYLOAD_JSON<<JIRAJSON\n")
        handle.write(encoded)
        handle.write("\nJIRAJSON\n")


if __name__ == "__main__":
    main()
