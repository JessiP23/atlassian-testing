#!/usr/bin/env bash
set -euo pipefail

# Copy GitHub agent profiles into Claude Code's expected agents directory for this run.
ROOT="${REPO_ROOT:-.}"
SRC="${ROOT}/.github/agents"
DEST="${ROOT}/.claude/agents"

mkdir -p "${DEST}"
shopt -s nullglob
for file in "${SRC}"/*.agent.md; do
  name="$(basename "${file}" .agent.md)"
  cp "${file}" "${DEST}/${name}.md"
done

echo "Staged agents:"
ls -1 "${DEST}"
