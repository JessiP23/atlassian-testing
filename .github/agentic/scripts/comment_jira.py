#!/usr/bin/env python3
"""Comment the new PR URL on the Jira issue. Never transition status."""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request

ISSUE_KEY = os.environ.get("ISSUE_KEY", "").strip()
PR_URL = os.environ.get("PR_URL", "").strip()
BLOCKED_BODY_FILE = os.environ.get("BLOCKED_BODY_FILE", "").strip()
BASE_URL = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
EMAIL = os.environ.get("JIRA_EMAIL", "")
TOKEN = os.environ.get("JIRA_API_TOKEN", "")

# Jira comments cap out well above this; keep blocked reports readable.
MAX_BLOCKED_CHARS = 6000


def candidate_bases() -> list[str]:
    """Site URL first (classic tokens), then the platform gateway (scoped tokens).

    Atlassian's newer "API tokens with scopes" only authenticate through
    https://api.atlassian.com/ex/jira/{cloudId}; against the site URL they 401.
    The cloud ID is public at {site}/_edge/tenant_info, so resolve it here rather
    than asking operators to know which token type they created.
    """
    bases = [BASE_URL]
    try:
        with urllib.request.urlopen(f"{BASE_URL}/_edge/tenant_info", timeout=10) as response:
            cloud_id = json.loads(response.read().decode("utf-8")).get("cloudId")
        if cloud_id:
            bases.append(f"https://api.atlassian.com/ex/jira/{cloud_id}")
    except (urllib.error.URLError, ValueError, KeyError):
        pass
    return bases


def preflight(auth_headers: dict[str, str]) -> str | None:
    """Return the first API base that accepts the credentials, or None.

    /rest/api/2/myself answers 200 for valid credentials and 401 otherwise.
    Without this check, bad secrets and an invisible issue both surface as an
    identical 404 from the comment endpoint.
    """
    last_code = None
    for base in candidate_bases():
        try:
            with urllib.request.urlopen(
                urllib.request.Request(f"{base}/rest/api/2/myself", headers=auth_headers),
                timeout=15,
            ) as response:
                who = json.loads(response.read().decode("utf-8"))
                name = who.get("displayName") or who.get("emailAddress") or "unknown"
                kind = "scoped token via api.atlassian.com" if "api.atlassian.com" in base else "classic token via site URL"
                print(f"Jira auth OK as {name} ({kind})")
                return base
        except urllib.error.HTTPError as err:
            last_code = err.code
            print(f"Jira auth preflight: HTTP {err.code} from {base}", file=sys.stderr)
            if err.code not in (401, 403, 404):
                break
    print("Jira auth preflight failed on every endpoint.", file=sys.stderr)
    if last_code == 401:
        print(
            "JIRA_EMAIL / JIRA_API_TOKEN were rejected by both the site URL and the "
            "api.atlassian.com gateway. Check for whitespace in the secrets, confirm the "
            "email is the Atlassian account that created the token, and if the token has "
            "scopes make sure it includes write:jira-work (or recreate it without scopes).",
            file=sys.stderr,
        )
    elif last_code == 404:
        print(
            "JIRA_BASE_URL does not look like a Jira site "
            "(expected https://your-site.atlassian.net with no trailing path).",
            file=sys.stderr,
        )
    return None


def build_comment() -> str | None:
    if PR_URL:
        return (
            f"GitHub agent opened a review-only pull request for {ISSUE_KEY}: {PR_URL}\n\n"
            "This PR will not be merged automatically."
        )
    if BLOCKED_BODY_FILE and os.path.isfile(BLOCKED_BODY_FILE):
        with open(BLOCKED_BODY_FILE, encoding="utf-8") as fh:
            body = fh.read().strip()
        if len(body) > MAX_BLOCKED_CHARS:
            body = body[:MAX_BLOCKED_CHARS] + "\n\n[truncated]"
        return (
            f"GitHub agent did not open a pull request for {ISSUE_KEY}. "
            "The ticket could not be implemented as written:\n\n" + body
        )
    return None


def main() -> int:
    if not ISSUE_KEY:
        print("ISSUE_KEY is required", file=sys.stderr)
        return 1
    if not BASE_URL or not EMAIL or not TOKEN:
        print("Jira comment skipped (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set)")
        return 0

    text = build_comment()
    if text is None:
        print("Nothing to report: no PR URL and no blocked body file")
        return 0
    # API v2 accepts a plain string body; v3 requires ADF.
    payload = json.dumps({"body": text}).encode("utf-8")

    # Send Basic auth preemptively. Jira Cloud answers anonymous requests with
    # 404 and no WWW-Authenticate challenge, so urllib's HTTPBasicAuthHandler
    # (which waits for a 401 before attaching credentials) never authenticates.
    credentials = base64.b64encode(f"{EMAIL}:{TOKEN}".encode("utf-8")).decode("ascii")
    auth_headers = {"Accept": "application/json", "Authorization": f"Basic {credentials}"}

    api_base = preflight(auth_headers)
    if api_base is None:
        return 1

    url = f"{api_base}/rest/api/2/issue/{ISSUE_KEY}/comment"
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as response:
            status = response.status
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        print(f"Jira comment failed: HTTP {err.code} from {url}", file=sys.stderr)
        print(body, file=sys.stderr)
        if err.code == 404:
            print(
                f"Auth is valid, so {ISSUE_KEY} is not visible to this account "
                "or the key does not exist in this site.",
                file=sys.stderr,
            )
        return 1
    if status >= 300:
        print(f"Jira comment failed: {status}", file=sys.stderr)
        return 1
    print(f"Commented on {ISSUE_KEY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
