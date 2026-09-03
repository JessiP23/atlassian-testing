#!/usr/bin/env bash
# Test Jira credentials from your own machine before touching GitHub secrets.
#
#   bash .github/agentic/scripts/check_jira_local.sh [ISSUE-KEY]
#
# Prompts for the site URL, email, and API token (token input is hidden), then
# runs the same preflight the "Jira connection check" workflow runs. Nothing is
# written to Jira and nothing is stored on disk.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISSUE_KEY="${1:-}"

read -r -p "Jira site URL (e.g. https://your-site.atlassian.net): " JIRA_BASE_URL
read -r -p "Atlassian account email: " JIRA_EMAIL
read -r -s -p "API token (hidden): " JIRA_API_TOKEN
echo

export JIRA_CHECK_ONLY=1 ISSUE_KEY JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN
python3 "${HERE}/comment_jira.py"
