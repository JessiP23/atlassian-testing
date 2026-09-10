#!/usr/bin/env bash
# Try the CURRENT commit's image on one or more tickets, without touching the release pin.
#
#   agent/graph/bin/try.sh ESI2-3434 [ESI2-3265 …]
#
# Waits for "Build panda-agent image" of HEAD to finish (so the run never hits the stale-edge guard), then
# dispatches each ticket with image_tag=edge. Label-triggered runs keep using PAG_IMAGE_TAG.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 ESI2-KEY [ESI2-KEY …]"; exit 2; }
sha=$(git rev-parse HEAD)
if [ -n "$(git status --porcelain -- agent .github 2>/dev/null)" ]; then echo "uncommitted changes under agent/ or .github/ — commit and push first"; exit 1; fi
if ! git merge-base --is-ancestor "$sha" "origin/$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null; then echo "HEAD is not pushed — git push first"; exit 1; fi

echo "waiting for the image build of ${sha:0:7}…"
for i in $(seq 1 60); do
  run=$(gh run list --workflow build-image.yml --commit "$sha" --limit 1 --json databaseId,status,conclusion -q '.[0]' 2>/dev/null || true)
  status=$(jq -r '.status // empty' <<<"$run"); conclusion=$(jq -r '.conclusion // empty' <<<"$run")
  if [ "$status" = completed ]; then
    [ "$conclusion" = success ] || { echo "build of ${sha:0:7} ended with: $conclusion"; exit 1; }
    echo "image edge = ${sha:0:7}"; break
  fi
  [ $i = 60 ] && { echo "no successful build of ${sha:0:7} after 10 min — gh run list --workflow build-image.yml"; exit 1; }
  sleep 10
done

for key in "$@"; do
  gh workflow run pioneer-ticket-to-pr.yml -f "issue_key=$key" -f image_tag=edge >/dev/null && echo "dispatched $key"
done
sleep 5; gh run list --workflow pioneer-ticket-to-pr.yml --limit "$#"
