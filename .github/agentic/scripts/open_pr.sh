#!/usr/bin/env bash
set -euo pipefail

# Open a review-only PR for this run. Never merge. Never enable auto-merge.
ISSUE_KEY="${ISSUE_KEY:?ISSUE_KEY is required}"
BRANCH="${BRANCH:?BRANCH is required}"
BASE="${BASE_BRANCH:?BASE_BRANCH is required}"
TITLE="${PR_TITLE:?PR_TITLE is required}"
BODY_FILE="${PR_BODY_FILE:?PR_BODY_FILE is required}"

if [[ "${BRANCH}" == "${BASE}" ]]; then
  echo "Refusing to open a PR from the default branch" >&2
  exit 1
fi

# Compare against the remote base explicitly; a local "${BASE}" ref may not exist
# in a CI checkout of the run branch.
git fetch --quiet origin "${BASE}"
if [[ "$(git rev-list --count "origin/${BASE}..HEAD")" == "0" ]]; then
  echo "No commits on ${BRANCH} relative to ${BASE}; skipping PR (blocked or no-op run)" >&2
  exit 0
fi

if [[ ! -s "${BODY_FILE}" ]]; then
  echo "PR body file is empty" >&2
  exit 1
fi

LABELS="${PR_LABELS:-agent-pr,needs-human-review}"
ARGS=(pr create --base "${BASE}" --head "${BRANCH}" --title "${TITLE}" --body-file "${BODY_FILE}")

if [[ "${PR_DRAFT:-false}" == "true" ]]; then
  ARGS+=(--draft)
fi

PR_URL="$(gh "${ARGS[@]}")"

IFS=',' read -ra LABEL_ARR <<< "${LABELS}"
for label in "${LABEL_ARR[@]}"; do
  trimmed="${label// /}"
  [[ -z "${trimmed}" ]] && continue
  gh label create "${trimmed}" --force >/dev/null 2>&1 || true
  gh pr edit "${PR_URL}" --add-label "${trimmed}" || true
done

# Belt and suspenders: never leave auto-merge on.
gh pr merge "${PR_URL}" --disable-auto || true

echo "Opened review-only PR: ${PR_URL}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "pr_url=${PR_URL}" >> "${GITHUB_OUTPUT}"
fi
