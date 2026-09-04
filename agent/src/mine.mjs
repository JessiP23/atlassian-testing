// The Miner. Extracts ground truth from merged pull requests.
//
// This is the asset nobody uses. Every merged PR is a labelled example of
// "this ticket text -> these files", written by an engineer who was right. Years of them
// are sitting in the git history. That is a training set and an evaluation set for free.
//
// Method: for each merge commit whose subject carries a ticket key, diff the merge base
// against the merged branch tip (the 3-dot diff). That yields ONLY what the branch
// changed, excluding everything it absorbed from main while it was open - which is the
// difference between 1 useful file and 278 noisy ones.

import { execFileSync } from 'node:child_process'

const KEY_RE = /\b([A-Z][A-Z0-9]{1,7}-\d+)\b/
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const NOISE_RE = /(\.d\.ts|\.spec\.[tj]sx?|\.test\.[tj]sx?|\.stories\.[tj]sx?)$/
const EXCLUDE_PATH_RE = /^(openspec|agent-docs|panda-code-agent|docs|\.github)\//

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
}

/**
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {string} [o.ref]      branch to mine (default origin/main)
 * @param {string} [o.since]    git date, e.g. '2024-06-01'
 * @param {number} [o.maxFiles] drop merges touching more than this many source files
 */
export function mine({ repoRoot, ref = 'origin/main', since = '2024-01-01', maxFiles = 40 }) {
  const raw = git(repoRoot, [
    'log', ref, '--merges', `--since=${since}`,
    '--pretty=%H\t%ad\t%s', '--date=short',
  ]).trim()

  const samples = []
  const skipped = { noKey: 0, noParents: 0, tooBig: 0, noSource: 0 }

  for (const line of raw.split('\n')) {
    if (!line) continue
    const [sha, date, ...rest] = line.split('\t')
    const subject = rest.join('\t')
    const km = subject.match(KEY_RE)
    if (!km) { skipped.noKey++; continue }
    const key = km[1]

    // The branch name in the merge subject carries the ticket slug, which is a good
    // stand-in for the ticket title. No Jira API call needed to build the eval set.
    const branch = (subject.match(/from\s+\S+?\/(\S+)/) || [])[1] || ''
    const text = branch.replace(/[-_/]+/g, ' ')

    let files
    try {
      const base = git(repoRoot, ['merge-base', `${sha}^1`, `${sha}^2`]).trim()
      files = git(repoRoot, ['diff', '--name-only', base, `${sha}^2`]).trim().split('\n')
    } catch { skipped.noParents++; continue }

    const src = files.filter(
      (f) => f && SOURCE_RE.test(f) && !NOISE_RE.test(f) && !EXCLUDE_PATH_RE.test(f)
    )
    if (!src.length) { skipped.noSource++; continue }
    // A merge touching hundreds of files is a release or a sweeping refactor, not a ticket.
    if (src.length > maxFiles) { skipped.tooBig++; continue }

    samples.push({ key, date, sha, text: `${key} ${text}`, files: src })
  }

  // Keep the newest record per ticket key (re-merges of the same ticket are common).
  const byKey = new Map()
  for (const s of samples) {
    const prev = byKey.get(s.key)
    if (!prev || s.date > prev.date) byKey.set(s.key, s)
  }

  const out = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date))
  return { samples: out, skipped, totalMerges: raw.split('\n').length }
}
