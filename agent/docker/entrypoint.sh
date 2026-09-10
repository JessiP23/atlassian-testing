#!/usr/bin/env bash
# Start the virtual display once, then run whatever the job asked for. GitHub Actions overrides the
# entrypoint for `container:` jobs, so the workflow also starts Xvfb explicitly — this covers `docker run`.
set -e
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb "${DISPLAY:-:99}" -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
  sleep 0.5
fi
exec "$@"
