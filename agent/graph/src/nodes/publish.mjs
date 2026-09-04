// PR packaging + publish. Fast tier writes the prose; git and gh do the rest deterministically.
//
// The branch is created HERE, from origin/<baseBranch>, by the workflow. Never by the model.
// On ESI2-3376 both triage and propose flagged that `bug/ESI2-3376-...` did not exist and that
// apply "must create it from origin/main before committing" — and nothing did, so the run's work
// sat on `jessi/panda-agent`, five commits ahead of main with the agent's own source in the diff.
// Branch creation is a deterministic step. It does not belong in a prompt.
//
// Also kept from Cody, verbatim in spirit: `git add <explicit paths>`, NEVER `git add -A`. His
// finalize-pr.sh says so in a comment and honours it; his push-failed-branch.sh is the one place
// that uses -A, and that is exactly the path a budget-capped run takes.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { converseJson } from '../lib/bedrock.mjs'
import { tierFor, estimateCost } from '../lib/models.mjs'

const exec = promisify(execFile)
const git = (repo, args) => exec('git', args, { cwd: repo, maxBuffer: 1 << 24 })

const SYSTEM = `Write the PR for a bug fix. Reviewers are busy engineers who did not read the ticket.

Return JSON: {"title":str,"body":str,"testNotes":str,"rolloutNotes":str,"manualSteps":[str]}

- title: conventional-commit style, <=64 chars, includes the issue key. Do NOT add any bot prefix
  yourself — the workflow prepends one.
- body: what was broken, the root cause in one or two sentences with file:line, and what changed.
  Every file:line you cite MUST be a file in the diff. State plainly what you did NOT do.
  Do not describe test evidence or how to verify — the workflow appends those from its own records.
- testNotes: which tests were added and the exact condition each pins.
- rolloutNotes: deploy/migration risk, or "none" if truly none.
- manualSteps: 2-5 numbered steps a human follows in the product to confirm the fix, derived ONLY
  from the acceptance criteria — never invent screens or data the ticket did not mention.`

/**
 * The evidence block is TEMPLATED from state, never written by a model: the red log, the green
 * log and the gate verdict are the runner's output, quoted. A reviewer who reads only this section
 * knows what was proven and what was not.
 */
function evidenceBlock(s, budget, href = (f) => `evidence/${f}`) {
  const r = s.repro
  const e = s.evidence
  const lines = ['## Evidence']
  if (r?.status === 'red' && e?.reproGreen) {
    const isE2e = r.rung === 'e2e'
    lines.push(
      isE2e
        ? `**Witness:** a Playwright spec drove the running app (${r.appUrl || 'local dev server'}) — written before the fix, frozen (sha256 \`${String(r.sha).slice(0, 12)}\`), red before, green after. The spec is below; screenshots and video are the runner's output.`
        : `**Reproducing test:** \`${r.file}\` — written before the fix, frozen (sha256 \`${String(r.sha).slice(0, 12)}\`), red before, green after.`,
      '',
    )
    if (isE2e && (r.before?.shots?.length || e.after?.shots?.length)) {
      // PAIR BY STATE NAME, not by index. The two runs do not produce the same number of frames:
      // before the fix the flow breaks partway, after it completes. Index pairing then puts
      // "01-initial-load" next to "03-reloaded" and the table lies. The name is the contract
      // (witness/fixtures.mjs), so `02-after-toggle-dark` sits beside its own counterpart and a
      // state the broken app never reached is shown as exactly that.
      const key = (f) => String(f).replace(/^(before|after)-/, '').replace(/\.png$/, '')
      const label = (k) => k.replace(/^\d+[-_]?/, '').replace(/[-_]+/g, ' ').trim() || k
      const B = new Map((r.before?.shots || []).map((f) => [key(f), f]))
      const A = new Map((e.after?.shots || []).map((f) => [key(f), f]))
      const states = [...new Set([...B.keys(), ...A.keys()])].sort()
      lines.push(
        `| State | Before (\`${s.baseBranch}@${String(s.baseSha).slice(0, 7)}\`) | After this patch |`,
        '|---|---|---|',
      )
      for (const k of states.slice(0, 8)) {
        const b = B.get(k), a = A.get(k)
        lines.push(`| **${label(k)}** | ${b ? `![before ${label(k)}](${href(b)})` : '_not reached before the fix_'} | ${a ? `![after ${label(k)}](${href(a)})` : '_not reached_'} |`)
      }
      lines.push('')
      const missing = states.filter((k) => !B.has(k))
      if (missing.length) lines.push(`The broken build never reached ${missing.length} of these states — that gap is part of the evidence.`, '')
      if (e.after?.gif) lines.push(`![walkthrough after the fix](${href(e.after.gif)})`, '')
      const links = [
        r.before?.video && `[before.webm](${href(r.before.video)})`, e.after?.video && `[after.webm](${href(e.after.video)})`,
        r.before?.trace && `[before trace](${href(r.before.trace)})`, e.after?.trace && `[after trace](${href(e.after.trace)})`,
      ].filter(Boolean)
      if (links.length) lines.push(`Full video and Playwright traces: ${links.join(' · ')}`, '')
    }
    lines.push(
      `<details><summary>Before this patch (\`${s.baseBranch}@${String(s.baseSha).slice(0, 7)}\`) — FAIL</summary>`,
      '', '```', (r.redExcerpt || '').slice(0, 3000), '```', '</details>',
      '',
      `<details><summary>After this patch — PASS</summary>`,
      '', '```', (e.greenExcerpt || '').slice(0, 3000), '```', '</details>',
    )
    if (isE2e) {
      let spec = ''
      try { spec = fs.readFileSync(r.file, 'utf8') } catch { /* not readable here */ }
      if (spec) lines.push('', '<details><summary>The witness spec (re-run it with the command under How to verify)</summary>', '', '```js', spec.slice(0, 6000), '```', '</details>')
    }
  } else {
    lines.push(
      `**No reproducing test.** ${r?.reason ? r.reason : 'The reproduce step did not run.'}`,
      'The gate below proves no regressions in the owning projects; it does not prove the reported symptom is gone. Review the diff against the acceptance criteria.',
    )
  }
  lines.push(
    '',
    `**Gate:** ${s.gate?.summary || '—'} · projects: ${(s.scope?.owners || []).join(', ') || '—'} · baseline \`${String(s.baseSha).slice(0, 7)}\``,
  )
  return lines.join('\n')
}

function verifyBlock(s, pr) {
  const lines = ['## How to verify']
  if (s.repro?.status === 'red' && s.repro.cmd) lines.push('```', s.repro.cmd, '```')
  const steps = Array.isArray(pr.manualSteps) ? pr.manualSteps.filter(Boolean) : []
  const fallback = (s.spec?.acceptanceCriteria || [])
  const list = steps.length ? steps : fallback
  if (list.length) lines.push(...list.map((x, i) => `${i + 1}. ${String(x).replace(/^\d+[.)]\s*/, '')}`))
  return lines.join('\n')
}

const EVIDENCE_BRANCH = process.env.PAG_EVIDENCE_BRANCH || 'agent-evidence'

/** Copy the run's evidence/ into <KEY>/<runId>/ on the orphan evidence branch. Returns an href fn. */
async function pushEvidence({ repo, remote, slug, issueKey, runId }) {
  const src = path.join(process.env.PAG_RUN_DIR, 'evidence')
  if (!fs.existsSync(src)) return null
  // In CI `origin` is authenticated by an http.extraheader on THIS clone, which a second clone
  // does not inherit — so build a token URL when one is available and fall back to the remote.
  const { stdout: remoteUrl } = await git(repo, ['remote', 'get-url', remote])
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const url = token ? `https://x-access-token:${token}@github.com/${slug}.git` : remoteUrl
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pag-evidence-'))
  const g = (args) => exec('git', args, { cwd: tmp, maxBuffer: 1 << 24 })
  await g(['init', '-q'])
  await g(['remote', 'add', 'origin', String(url).trim()])
  const exists = await g(['fetch', '-q', '--depth', '1', 'origin', EVIDENCE_BRANCH]).then(() => true).catch(() => false)
  if (exists) await g(['checkout', '-q', '-B', EVIDENCE_BRANCH, 'FETCH_HEAD'])
  else await g(['checkout', '-q', '--orphan', EVIDENCE_BRANCH])
  const dest = path.join(tmp, issueKey, runId)
  fs.mkdirSync(dest, { recursive: true })
  const keep = /\.(png|gif|webm|zip|log|mjs|ts)$/
  for (const f of fs.readdirSync(src)) if (keep.test(f) && fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(dest, f))
  const wdir = path.join(src, 'witness')
  if (fs.existsSync(wdir)) for (const f of fs.readdirSync(wdir)) fs.copyFileSync(path.join(wdir, f), path.join(dest, f))
  await g(['add', '-A', '--', path.join(issueKey, runId)])
  await g(['-c', 'user.name=panda-agent', '-c', 'user.email=panda-agent@assetpanda.com', 'commit', '-q', '-m', `${issueKey}: evidence for run ${runId}`])
  await g(['push', '-q', 'origin', `HEAD:refs/heads/${EVIDENCE_BRANCH}`])
  fs.rmSync(tmp, { recursive: true, force: true })
  return (f) => `https://github.com/${slug}/blob/${EVIDENCE_BRANCH}/${issueKey}/${runId}/${encodeURIComponent(f)}?raw=true`
}

/** Every `path.ts:123` the model cites must be a file in the diff — otherwise the claim is flagged, not trusted. */
function citationCheck(body, changed) {
  const cited = [...String(body).matchAll(/([\w./@-]+\.(?:[tj]sx?|graphql|json)):\d+/g)].map((m) => m[1])
  const set = new Set(changed)
  const bad = [...new Set(cited.filter((f) => ![...set].some((c) => c === f || c.endsWith('/' + f) || f.endsWith('/' + c))))]
  return bad
}

export function publishNode({ budget, dryRun = false }) {
  return async (s) => {
    const tier = tierFor('package')

    const { stdout: diff } = await git(s.repo, ['diff', 'HEAD', '--stat'])
    const { data, inTok, outTok } = await converseJson({
      model: tier.model,
      system: SYSTEM,
      maxTokens: tier.maxTokens,
      user: [
        `ISSUE: ${s.issueKey} — ${s.spec.summary}`,
        `ACCEPTANCE:\n${(s.spec.acceptanceCriteria || []).map((a) => `- ${a}`).join('\n')}`,
        `PLAN STEPS:\n${(s.plan.steps || []).map((a) => `- ${a}`).join('\n')}`,
        `TESTS ADDED:\n${(s.plan.newTests || []).map((t) => `- ${t.file}: ${t.pins}`).join('\n')}`,
        `GATE: ${s.gate.summary}`,
        `DIFFSTAT:\n${diff}`,
      ].join('\n\n'),
    })
    budget.charge('package', estimateCost(tier, inTok, outTok), { model: tier.model, inTok, outTok })

    const pr = data
    const AGENT = process.env.PAG_AGENT_NAME || 'panda-agent'

    // Identifiable in a PR list without opening it, and greppable for reporting later.
    pr.title = `[${AGENT}] ${String(pr.title).replace(new RegExp(`^\\[${AGENT}\\]\\s*`), '')}`.slice(0, 100)

    // Body: what changed (files, with the diffstat) before the prose. A reviewer's first question
    // is always "how big is this", and the answer should not be three paragraphs down.
    const evidenceLabel = (s.repro?.status === 'red' && s.evidence?.reproGreen) ? (s.repro.rung === 'e2e' ? 'evidence:e2e' : 'evidence:repro') : 'evidence:none'
    const badCites = citationCheck(pr.body, s.changed)
    const fileList = s.changed.map((f) => `- \`${f}\``).join('\n')
    const banner = evidenceLabel === 'evidence:e2e' ? 'Evidence: witnessed in the running app — screenshots red → green'
      : evidenceLabel === 'evidence:repro' ? 'Evidence: reproducing test red → green'
      : 'Evidence: none — review against the acceptance criteria'
    const body = (href) => [
      `> **${banner}**`,
      '',
      pr.body,
      badCites.length ? `\n> ⚠ cites files that are not in this diff: ${badCites.map((f) => `\`${f}\``).join(', ')}` : '',
      '',
      evidenceBlock(s, budget, href),
      '',
      verifyBlock(s, pr),
      '',
      '## Files changed',
      fileList,
      '',
      '```',
      diff.trim(),
      '```',
    ].join('\n')
    pr.body = body()
    pr.evidenceLabel = evidenceLabel

    if (dryRun) {
      // Same file the live path would upload as the PR body, so a dry run can be read like a PR.
      try { if (process.env.PAG_RUN_DIR) fs.writeFileSync(`${process.env.PAG_RUN_DIR}/pr-body.md`, `# ${pr.title}\n\n${pr.body}\n\n## Tests\n${pr.testNotes}\n\n## Rollout\n${pr.rolloutNotes}`) } catch { /* bookkeeping */ }
      return { pr, prUrl: null }
    }

    // ---- REMOTE GUARD: never push to a repo that was not explicitly allowed -------------------
    //
    // On the first live run this pushed `bug/ESI2-3379-fix` to AssetPandaLLC/pioneer — the
    // production repo — because a git worktree shares its parent's remotes and `origin` there is
    // production. The operator's SSH key has write access, so the push succeeded; only `gh pr
    // create` failed, on the API token. A branch on production is recoverable, but the guarantee
    // "the PR goes to your fork" was never actually enforced anywhere. Cody's config carried
    // `repo.owner` for exactly this reason.
    //
    // So: the allowed remote is declared, and a mismatch aborts BEFORE anything is pushed.
    const allowed = (process.env.PAG_ALLOWED_REMOTE || '').trim()
    const { stdout: remoteUrl } = await git(s.repo, ['remote', 'get-url', 'origin'])
    const slug = (remoteUrl.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/) || [])[1] || remoteUrl.trim()

    if (!allowed) {
      return {
        pr,
        refusal: {
          at: 'publish',
          reason: 'no_allowed_remote',
          detail: `Refusing to push: PAG_ALLOWED_REMOTE is not set, and origin is "${slug}".\n` +
            `Set it in graph/.env to the repo the agent may push to, e.g.\n  PAG_ALLOWED_REMOTE=jessipavia/pioneer`,
        },
      }
    }
    if (slug.toLowerCase() !== allowed.toLowerCase()) {
      return {
        pr,
        refusal: {
          at: 'publish',
          reason: 'wrong_remote',
          detail: `Refusing to push. origin is "${slug}" but PAG_ALLOWED_REMOTE is "${allowed}".\n` +
            `A worktree inherits its parent checkout's remotes, so this is usually the production\n` +
            `repo. Add your fork as a remote and point the agent at it:\n` +
            `  git -C ${s.repo} remote add fork git@github.com:${allowed}.git\n` +
            `  PAG_PUSH_REMOTE=fork`,
        },
      }
    }

    // ---- evidence branch: PNG/GIF/webm/trace/spec/logs, so the PR body can show them ---------
    // GitHub renders repo-hosted images (`blob/<branch>/<path>?raw=true`) for anyone who can see the
    // repo; Jira attachment URLs need auth and show as broken images. So evidence goes to an orphan
    // branch in the same repo, under <KEY>/<runId>/, sweepable with one `git push --delete`.
    if (s.repro?.rung === 'e2e' && process.env.PAG_RUN_DIR) {
      const runId = path.basename(process.env.PAG_RUN_DIR)
      const href = await pushEvidence({ repo: s.repo, remote: process.env.PAG_PUSH_REMOTE || 'origin', slug: allowed, issueKey: s.issueKey, runId })
        .catch((e) => { console.error(`evidence branch failed: ${e.message}`); return null })
      if (href) pr.body = body(href)
    }

    // ---- branch, from the PINNED sha, by the workflow -----------------------------------------
    // Not from origin/<base>: the run's changes were made on top of the pinned commit, and
    // re-pointing the branch at a newer HEAD here would silently rebase them onto code the gate
    // never tested. The PR is then a few hours behind main, which GitHub merges fine.
    await git(s.repo, ['branch', '-f', s.branchName, s.baseSha]).catch(() => {})
    await git(s.repo, ['symbolic-ref', 'HEAD', `refs/heads/${s.branchName}`])
    await git(s.repo, ['reset', '--soft', s.baseSha])

    // ---- explicit paths only ------------------------------------------------------------------
    await git(s.repo, ['add', '--', ...s.changed])

    const rep = budget.report()
    const mins = Math.floor((rep.elapsedMs || 0) / 60_000), secs = Math.round(((rep.elapsedMs || 0) % 60_000) / 1000)
    const footer = [
      '',
      '---',
      `**Ticket** ${process.env.JIRA_URL || ''}/browse/${s.issueKey}`,
      `**Base** \`${s.baseBranch}@${String(s.baseSha).slice(0, 7)}\` — the commit the gate tested against`,
      `**Gate** ${s.gate.summary}`,
      `**Verified projects** ${(s.scope?.owners || []).join(', ') || '—'}`,
      `**Spend** $${rep.spent.toFixed(2)} · **Wall time** ${mins}m ${secs}s of ${rep.maxMinutes} min`,
      '',
      `🐼 Opened by \`${AGENT}\` on branch \`${s.branchName}\`. **Draft by design — this agent cannot merge.**`,
      'Its token carries `pull_requests:write` and `contents:write` and nothing else.',
    ].join('\n')

    await git(s.repo, [
      'commit', '-q',
      '-m', pr.title,
      '-m', `${pr.body}\n\n## Tests\n${pr.testNotes}\n\n## Rollout\n${pr.rolloutNotes}${footer}`,
    ])
    const pushRemote = process.env.PAG_PUSH_REMOTE || 'origin'
    await git(s.repo, ['push', pushRemote, `HEAD:refs/heads/${s.branchName}`])

    // ---- draft PR. The token carries pull_requests:write and contents:write, nothing else. ----
    // `gh` infers the repo from the remote and gets it wrong in a worktree — name it explicitly.
    const { stdout: url } = await exec('gh', [
      'pr', 'create',
      '--repo', allowed,
      '--draft',
      '--base', s.prTargetBranch,
      '--head', s.branchName,
      '--title', pr.title,
      '--body', `${pr.body}\n\n## Tests\n${pr.testNotes}\n\n## Rollout\n${pr.rolloutNotes}${footer}`,
    ], { cwd: s.repo })

    // Labels are best-effort: a fine-grained token without issues:write cannot create them, and a
    // missing label must never fail a PR that is already open. The body's first line carries the
    // same information regardless.
    const prUrl = url.trim()
    try {
      const desc = { 'evidence:e2e': 'witnessed in the running app: screenshots red before, green after', 'evidence:repro': 'reproducing test: red before, green after', 'evidence:none': 'no reproducing test — review against acceptance criteria' }
      await exec('gh', ['label', 'create', pr.evidenceLabel, '--repo', allowed, '--force', '--color',
        pr.evidenceLabel === 'evidence:none' ? 'A03A32' : '2E6B4F', '--description', desc[pr.evidenceLabel]], { cwd: s.repo })
      await exec('gh', ['pr', 'edit', prUrl, '--repo', allowed, '--add-label', pr.evidenceLabel], { cwd: s.repo })
    } catch { /* label is a convenience */ }

    return { pr, prUrl }
  }
}
