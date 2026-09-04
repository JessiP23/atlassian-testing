#!/usr/bin/env node
// SUPERSEDED by bin/refresh.mjs, which also invalidates and rebuilds project baselines and writes
// the pin that runs consume. Kept only so an old command line does not silently do half the job.
console.error(`
bin/refresh-index.mjs is superseded — it rebuilt the index but not the baselines or the pin.

Use:
  node bin/refresh.mjs --repo ~/pioneer-refresh --base main
`)
process.exit(1)
