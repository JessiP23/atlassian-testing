#!/usr/bin/env python3
"""Comment the new PR URL on the Jira issue. Never transition status."""

from __future__ import annotations

import json
import os
import sys
import urllib.request

ISSUE_KEY = os.environ.get("ISSUE_KEY", "").strip()
PR_URL = os.environ.get("PR_URL", "").strip()
BASE_URL = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
EMAIL = os.environ.get("JIRA_EMAIL", "")
TOKEN = os.environ.get("JIRA_API_TOKEN", "")


def main() -> int:
    if not ISSUE_KEY or not PR_URL:
        print("ISSUE_KEY and PR_URL are required", file=sys.stderr)
        return 1
    if not BASE_URL or not EMAIL or not TOKEN:
        print("Jira comment skipped (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set)")
        return 0

    text = (
        f"GitHub agent opened a review-only pull request for {ISSUE_KEY}: {PR_URL}\n\n"
        "This PR will not be merged automatically."
    )
    # API v2 accepts a plain string body; v3 requires ADF.
    payload = json.dumps({"body": text}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/rest/api/2/issue/{ISSUE_KEY}/comment",
        data=payload,
        method="POST",
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    password_mgr.add_password(None, BASE_URL, EMAIL, TOKEN)
    opener = urllib.request.build_opener(urllib.request.HTTPBasicAuthHandler(password_mgr))
    with opener.open(req) as response:
        if response.status >= 300:
            print(f"Jira comment failed: {response.status}", file=sys.stderr)
            return 1
    print(f"Commented on {ISSUE_KEY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
