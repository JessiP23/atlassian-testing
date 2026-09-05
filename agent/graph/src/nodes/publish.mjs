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
import { addComment, transition } from '../lib/jira.mjs'
import { formatFailures } from '../lib/gatelog.mjs'
import { pairShots } from '../lib/evidence.mjs'
import { termshot } from '../lib/termshot.mjs'

const exec = promisify(execFile)
const git = (repo, args) => exec('git', args, { cwd: repo, maxBuffer: 1 << 24 })

/** A log the run already saved, in full — the excerpt is for the body, the file is for the image. */
const readEvidence = (name) => {
  try { return fs.readFileSync(path.join(process.env.PAG_RUN_DIR, 'evidence', name), 'utf8') } catch { return '' }
}

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
export function evidenceBlock(s, budget, href = (f) => `evidence/${f}`, terminal = null) {
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
      // PAIR BY STATE NAME, not by index — see lib/evidence.mjs for why, and test/evidence.test.mjs
      // for the case that proves it (3 before-frames vs 8 after-frames must not shift the rows).
      const { rows, missingBefore } = pairShots(r.before?.shots || [], e.after?.shots || [])
      lines.push(
        `| State | Before (\`${s.baseBranch}@${String(s.baseSha).slice(0, 7)}\`) | After this patch |`,
        '|---|---|---|',
      )
      for (const row of rows) {
        lines.push(`| **${row.label}** | ${row.before ? `![before ${row.label}](${href(row.before)})` : '_not reached before the fix_'} | ${row.after ? `![after ${row.label}](${href(row.after)})` : '_not reached_'} |`)
      }
      lines.push('')
      if (missingBefore.length) lines.push(`The broken build never reached ${missingBefore.length} of these states — that gap is part of the evidence.`, '')
      if (e.after?.gif) lines.push(`![walkthrough after the fix](${href(e.after.gif)})`, '')
      const links = [
        r.before?.video && `[before.webm](${href(r.before.video)})`, e.after?.video && `[after.webm](${href(e.after.video)})`,
        r.before?.trace && `[before trace](${href(r.before.trace)})`, e.after?.trace && `[after trace](${href(e.after.trace)})`,
      ].filter(Boolean)
      if (links.length) lines.push(`Full video and Playwright traces: ${links.join(' · ')}`, '')
    }
    // The rendered terminal, when the evidence branch could host it. Text stays underneath either
    // way — the image is what a reviewer looks at, the text is what they can copy and re-run.
    if (terminal?.before || terminal?.after) {
      lines.push(
        `| \`${s.baseBranch}@${String(s.baseSha).slice(0, 7)}\` — before | after this patch |`,
        '|---|---|',
        `| ${terminal.before ? `![before](${href(terminal.before)})` : '_not captured_'} `
          + `| ${terminal.after ? `![after](${href(terminal.after)})` : '_not captured_'} |`,
        '',
        'Same command, same test file, same commit for the left-hand run. The text below is the same output.',
        '',
      )
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
  // Anything the deadline dropped is stated here, in the evidence section, not buried in a log.
  // A gate that skipped `build` proved less than a gate that ran it, and the reviewer decides what
  // that is worth — the workflow does not get to quietly call it green.
  if (s.gate?.skipped?.length) {
    lines.push(
      '',
      `> ⚠ **${s.gate.skipped.join(', ')} was not run** — the run reached its ${budget?.maxMinutes || 20}-minute deadline first. `
      + `Everything else above passed. CI on this PR runs the full gate.`,
    )
  }
  if (s.repro?.shipped?.length) {
    lines.push('', `The witness is in this diff as ${s.repro.shipped.map((f) => `\`${f}\``).join(' + ')}, so it is reviewable and re-runnable after merge.`)
  }
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

/**
 * Every file the PR body NAMES must be a file in the diff.
 *
 * This used to check only `path.ts:123` citations. On ESI2-3393 every false statement in the body
 * was a bare FILENAME instead: "The root cause was in `hasMoreDecimalsThanAllowed` in
 * format-filter-value.ts" (a function the previous run had invented, still sitting in a dirty
 * worktree), and "Added test in format-filter-value.test.ts" — a file the diff never touched. Both
 * sailed through, because neither carried a line number.
 *
 * A path in a PR body is a claim about the diff. It gets checked like one.
 */
function citationCheck(body, changed) {
  const named = [...String(body).matchAll(/([\w./@-]+\.(?:[tj]sx?|graphql|json|css|scss|mjs|cjs))(?::\d+)?/g)].map((m) => m[1])
  const set = [...new Set(changed)]
  const same = (f) => set.some((c) => c === f || c.endsWith('/' + f) || f.endsWith('/' + c))
  // package.json / tsconfig.json and friends get mentioned as context, not as claims about the diff.
  const CONTEXT = /^(package(-lock)?\.json|tsconfig(\.\w+)?\.json|nx\.json|jest\.config\.[tj]s)$/
  return [...new Set(named.filter((f) => !same(f) && !CONTEXT.test(f.split('/').pop())))]
}

/**
 * The branch already exists on the remote. Whose commits are on it?
 *
 * This decides between force-pushing over the agent's own earlier attempt (fine, and the whole
 * point of a re-run) and destroying a human's work (never). It is the difference between "run the
 * ticket again" being safe and being a data-loss bug.
 */
async function remoteBranchOwner({ repo, remote, branch, baseSha }) {
  const { stdout: ls } = await git(repo, ['ls-remote', '--heads', remote, branch]).catch(() => ({ stdout: '' }))
  if (!ls.trim()) return { exists: false, agentOnly: true, sha: null, authors: [] }
  const sha = ls.trim().split(/\s+/)[0]
  try {
    await git(repo, ['fetch', '-q', '--depth', '50', remote, `refs/heads/${branch}`])
    // Only the commits the BRANCH adds on top of the pinned base — the base branch's own history
    // is authored by everyone and says nothing about who owns this branch.
    const { stdout } = await git(repo, ['log', '--format=%ae', '-50', 'FETCH_HEAD', '--not', baseSha])
    const authors = [...new Set(stdout.split('\n').map((x) => x.trim()).filter(Boolean))]
    const isAgent = (e) => /panda-agent|\[bot\]|users\.noreply\.github\.com/.test(e)
    return { exists: true, agentOnly: authors.length > 0 && authors.every(isAgent), sha, authors }
  } catch {
    // Cannot tell: assume a human is on it. Costs one extra branch; the alternative costs their work.
    return { exists: true, agentOnly: false, sha, authors: ['unknown'] }
  }
}

/**
 * Open the PR, or update the one that is already open for this branch.
 *
 * `gh pr create` used to be called unconditionally. A second dispatch of the same ticket — a Jira
 * automation firing twice, a re-run after a flake, a human clicking the workflow button — got as
 * far as writing the fix, pushing the branch, and then died on `a pull request for branch ... already
 * exists`. The whole run was paid for and lost at the last step. Re-running a ticket has to be the
 * cheapest thing in the system, not the most dangerous.
 */
async function createOrUpdatePr({ repo, allowed, branch, base, title, body, draft = true, onProgress = () => {} }) {
  // --base matters as much as --head. Without it, `gh pr list --head agent/ESI2-3393-fix` returns
  // the PR targeting main, so the SECOND PR (the one meant for qa) found that one, decided it
  // already existed, and overwrote its body with the "lower-environment copy" text. One PR, wrong
  // description, and the log claiming two — which is what ESI2-3393 actually produced.
  const { stdout: found } = await exec('gh', [
    'pr', 'list', '--repo', allowed, '--head', branch, '--base', base, '--state', 'open',
    '--json', 'number,url,baseRefName', '--limit', '5',
  ], { cwd: repo }).catch(() => ({ stdout: '[]' }))
  const open = (() => {
    try { return JSON.parse(found).find((p) => p.baseRefName === base) || null } catch { return null }
  })()

  if (open?.number) {
    onProgress(`PR #${open.number} is already open for ${branch} — updating it in place`)
    await exec('gh', ['pr', 'edit', String(open.number), '--repo', allowed, '--title', title, '--body', body], { cwd: repo })
    return { url: open.url, updated: true }
  }
  const args = ['pr', 'create', '--repo', allowed, '--base', base, '--head', branch, '--title', title, '--body', body]
  if (draft) args.push('--draft')
  const { stdout: url } = await exec('gh', args, { cwd: repo })
  return { url: url.trim(), updated: false }
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
    const inc = s.incomplete || null

    // Identifiable in a PR list without opening it, and greppable for reporting later. An
    // incomplete hand-over says so in the title, because that is the only part of a PR that shows
    // up in a notification, a list and a Slack unfurl.
    pr.title = `[${AGENT}]${inc ? '[INCOMPLETE]' : ''} ${String(pr.title).replace(new RegExp(`^\\[${AGENT}\\](?:\\[INCOMPLETE\\])?\\s*`), '')}`.slice(0, 100)

    // Body: what changed (files, with the diffstat) before the prose. A reviewer's first question
    // is always "how big is this", and the answer should not be three paragraphs down.
    const evidenceLabel = (s.repro?.status === 'red' && s.evidence?.reproGreen) ? (s.repro.rung === 'e2e' ? 'evidence:e2e' : 'evidence:repro') : 'evidence:none'
    // Filled in below, before the body is rendered with real hrefs. Declared here because body()
    // closes over it — an explicit local beats reassigning the node's own `s`.
    let terminal = null
    const badCites = citationCheck(pr.body, s.changed)
    const fileList = s.changed.map((f) => `- \`${f}\``).join('\n')
    const banner = evidenceLabel === 'evidence:e2e' ? 'Evidence: witnessed in the running app — screenshots red → green'
      : evidenceLabel === 'evidence:repro' ? 'Evidence: reproducing test red → green'
      : 'Evidence: none — review against the acceptance criteria'

    // The hand-over block. A run that reached its deadline with the gate still red used to refuse:
    // the branch was deleted, the diff survived only as a workflow artifact, and the ticket got a
    // log tail. That threw away the expensive part — the diagnosis and the code — at the one moment
    // it was finally worth something. So the work is published as an explicitly INCOMPLETE draft
    // with the failure at the top. A human decides whether to finish it or bin it; the workflow's
    // job is to hand them something to decide about.
    const handover = inc ? [
      '> [!WARNING]',
      `> **This is an unfinished hand-over, not a proposed fix.** ${inc.reason}`,
      '>',
      `> The gate is still red: ${s.gate?.summary || 'unknown'}`,
      '>',
      `> Nothing here is merge-ready. What it gives you is the branch, the diff, and the evidence`,
      `> below, so the ${(budget.elapsedMs() / 60_000).toFixed(0)} minutes and $${budget.report().spent.toFixed(2)} already spent on the diagnosis are not lost.`,
      (s.gate?.failures || []).length ? `>\n> Remaining failures:\n>\n${formatFailures(s.gate.failures).split('\n').map((l) => `> ${l}`).join('\n')}` : '',
      '',
    ].filter(Boolean).join('\n') : ''

    const body = (href) => [
      handover,
      `> **${banner}**`,
      '',
      pr.body,
      badCites.length ? `\n> ⚠ cites files that are not in this diff: ${badCites.map((f) => `\`${f}\``).join(', ')}` : '',
      '',
      evidenceBlock(s, budget, href, terminal),
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
    pr.labels = [evidenceLabel, ...(inc ? ['agent:incomplete'] : [])]

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
    // ---- the transcript, as an image ---------------------------------------------------------
    // The red/green text is already below; this is the same bytes rendered as the terminal actually
    // printed them, colours and all. It is not stronger proof in principle — it is the thing a
    // reviewer looks at, and it is harder to produce casually than a paragraph of prose. Costs about
    // two seconds and never fails a run: if the browser is missing, the text stands alone.
    if (s.repro?.status === 'red' && process.env.PAG_RUN_DIR && process.env.PAG_TERMSHOT !== '0') {
      const short = path.basename(s.repro.file)
      const [before, after] = await Promise.all([
        termshot({
          text: readEvidence('repro-red.log') || s.repro.redExcerpt,
          name: 'terminal-before', pass: false,
          title: s.repro.cmd ? s.repro.cmd.slice(0, 110) : short,
          subtitle: `${s.issueKey} · on ${s.baseBranch}@${String(s.baseSha).slice(0, 7)}, before the fix`,
        }),
        termshot({
          text: readEvidence('repro-green.log') || s.evidence?.greenExcerpt,
          name: 'terminal-after', pass: true,
          title: s.repro.cmd ? s.repro.cmd.slice(0, 110) : short,
          subtitle: `${s.issueKey} · same command, same test, after the fix`,
        }),
      ])
      if (before || after) {
        terminal = { before: before && path.basename(before), after: after && path.basename(after) }
        console.error(`rendered the transcript: ${Object.values(terminal).filter(Boolean).join(', ')}`)
      }
    }

    if (process.env.PAG_RUN_DIR) {
      const runId = path.basename(process.env.PAG_RUN_DIR)
      const href = await pushEvidence({ repo: s.repo, remote: process.env.PAG_PUSH_REMOTE || 'origin', slug: allowed, issueKey: s.issueKey, runId })
        .catch((e) => { console.error(`evidence branch failed: ${e.message}`); return null })
      if (href) pr.body = body(href)
    }

    // ---- branch, from the PINNED sha, by the workflow -----------------------------------------
    // Not from origin/<base>: the run's changes were made on top of the pinned commit, and
    // re-pointing the branch at a newer HEAD here would silently rebase them onto code the gate
    // never tested. The PR is then a few hours behind main, which GitHub merges fine.
    //
    // RE-RUN SAFETY. The same ticket can be dispatched twice — a Jira automation firing on two
    // transitions, a human pressing the workflow button, a retry after a flake. Three cases, and
    // only the third is dangerous:
    //   nothing on the remote      -> push, open the PR
    //   only the agent's commits   -> force-push over its own earlier attempt, update the open PR
    //   a human commit is on it    -> DO NOT touch it. Push a suffixed branch and open a second PR.
    const pushRemote = process.env.PAG_PUSH_REMOTE || 'origin'
    const owner = await remoteBranchOwner({ repo: s.repo, remote: pushRemote, branch: s.branchName, baseSha: s.baseSha })
    let branch = s.branchName
    let supersedes = ''
    if (owner.exists && !owner.agentOnly) {
      let n = 2
      while (n < 20 && (await remoteBranchOwner({ repo: s.repo, remote: pushRemote, branch: `${s.branchName}-r${n}`, baseSha: s.baseSha })).exists) n++
      branch = `${s.branchName}-r${n}`
      supersedes = `\n\n> \`${s.branchName}\` already carries commits by ${owner.authors.join(', ')}, so this run did NOT touch it. `
        + `Its work is on \`${branch}\` instead.`
      console.error(`branch ${s.branchName} has non-agent commits (${owner.authors.join(', ')}) — using ${branch}`)
    }

    await git(s.repo, ['branch', '-f', branch, s.baseSha]).catch(() => {})
    await git(s.repo, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
    await git(s.repo, ['reset', '--soft', s.baseSha])

    // ---- explicit paths only ------------------------------------------------------------------
    await git(s.repo, ['add', '--', ...s.changed])

    const rep = budget.report()
    const mins = Math.floor((rep.elapsedMs || 0) / 60_000), secs = Math.round(((rep.elapsedMs || 0) % 60_000) / 1000)
    const phases = (rep.phases || []).map((p) => `${p.node} ${(p.ms / 1000).toFixed(0)}s`).join(' · ')
    const footer = [
      '',
      '---',
      `**Ticket** ${process.env.JIRA_URL || ''}/browse/${s.issueKey}`,
      `**Base** \`${s.baseBranch}@${String(s.baseSha).slice(0, 7)}\` — the commit the gate tested against`,
      `**Gate** ${s.gate?.summary || '—'}`,
      `**Verified projects** ${(s.scope?.owners || []).join(', ') || '—'}`,
      `**Spend** $${rep.spent.toFixed(2)} · **Wall time** ${mins}m ${secs}s of ${rep.maxMinutes} min`,
      phases ? `**Phases** ${phases}` : '',
      supersedes,
      '',
      `🐼 Opened by \`${AGENT}\` on branch \`${branch}\`. **Draft by design — this agent cannot merge.**`,
      'Its token carries `pull_requests:write` and `contents:write` and nothing else.',
    ].filter(Boolean).join('\n')

    const fullBody = `${pr.body}\n\n## Tests\n${pr.testNotes}\n\n## Rollout\n${pr.rolloutNotes}${footer}`

    await git(s.repo, ['commit', '-q', '-m', pr.title, '-m', fullBody])
    // force is safe here and only here: `owner.agentOnly` was checked above, so the only history
    // being overwritten is this agent's own previous attempt at the same ticket.
    await git(s.repo, ['push', ...(owner.exists && owner.agentOnly ? ['--force'] : []), pushRemote, `HEAD:refs/heads/${branch}`])

    // ---- draft PR, created or updated ---------------------------------------------------------
    // The token carries pull_requests:write and contents:write, nothing else.
    // `gh` infers the repo from the remote and gets it wrong in a worktree — name it explicitly.
    const { url: prUrl, updated } = await createOrUpdatePr({
      repo: s.repo, allowed, branch, base: s.prTargetBranch,
      title: pr.title, body: fullBody, draft: true,
      onProgress: (l) => console.error(l),
    })

    // ---- the same branch, a second PR into a lower environment --------------------------------
    //
    // Asset Panda's flow: the fix branches from main and its PR targets main, and a SECOND PR from
    // THE SAME BRANCH targets qa so the change can be deployed and tested on a lower environment
    // before it lands. One branch, two destinations — not a cherry-pick and not a second run, so
    // the two PRs can never drift apart.
    //
    // Best-effort by construction: a missing target branch, or a repo without a qa at all, must not
    // fail a run whose primary PR is already open. PAG_PR_EXTRA_TARGETS is a comma-separated list;
    // empty disables it entirely.
    const extraTargets = (process.env.PAG_PR_EXTRA_TARGETS || '')
      .split(',').map((x) => x.trim()).filter(Boolean)
      .filter((t) => t !== s.prTargetBranch)      // never open a PR from a branch into itself
    const extraPrs = []
    for (const t of extraTargets) {
      const note = [
        `> **Lower-environment copy.** Same branch as ${prUrl}, targeting \`${t}\` so this can be`,
        `> deployed and tested before it lands on \`${s.prTargetBranch}\`. Reviewing it twice is not`,
        '> necessary — read it there, test it here.',
        '',
      ].join('\n')
      const r = await createOrUpdatePr({
        repo: s.repo, allowed, branch, base: t,
        title: `${pr.title} [-> ${t}]`.slice(0, 100), body: note + fullBody, draft: true,
        onProgress: (l) => console.error(l),
      }).catch((e) => {
        console.error(`second PR into ${t} not opened: ${String(e.message).split('\n')[0].slice(0, 140)}`)
        return null
      })
      if (r) { extraPrs.push({ target: t, url: r.url }); console.error(`jira: also opened ${r.url} -> ${t}`) }
    }

    // Labels are best-effort: a fine-grained token without issues:write cannot create them, and a
    // missing label must never fail a PR that is already open. The body's first line carries the
    // same information regardless.
    try {
      const desc = {
        'evidence:e2e': 'witnessed in the running app: screenshots red before, green after',
        'evidence:repro': 'reproducing test: red before, green after',
        'evidence:none': 'no reproducing test — review against acceptance criteria',
        'agent:incomplete': 'the agent ran out of clock with the gate red — hand-over, not a fix',
      }
      for (const label of pr.labels) {
        await exec('gh', ['label', 'create', label, '--repo', allowed, '--force', '--color',
          label === 'evidence:none' ? 'A03A32' : label === 'agent:incomplete' ? '8A6A12' : '2E6B4F',
          '--description', desc[label] || label], { cwd: s.repo })
      }
      for (const u of [prUrl, ...extraPrs.map((x) => x.url)]) {
        await exec('gh', ['pr', 'edit', u, '--repo', allowed, '--add-label', pr.labels.join(',')], { cwd: s.repo })
      }
    } catch { /* labels are a convenience */ }

    // ---- write back to Jira -------------------------------------------------------------------
    // The gap this closes: `addComment` was only ever called on the REFUSE path. A successful run
    // left no trace on the ticket at all, so the person who filed it had no way to know a PR
    // existed unless they were watching the repo. Half of what makes this feel like a teammate is
    // that it answers where it was asked.
    if (process.env.PAG_JIRA_COMMENT !== '0') {
      const evidenceLine = {
        'evidence:e2e': 'Screenshots of the broken and fixed states are in the PR, paired state by state.',
        'evidence:repro': 'A reproducing test was written before the fix, red on the base commit and green after it.',
        'evidence:none': 'No reproducing test — please review the diff against the acceptance criteria.',
      }[evidenceLabel]
      const lines = inc ? [
        `${AGENT} could not finish this one inside its ${rep.maxMinutes}-minute budget, and has handed over what it has.`,
        '', `**Draft PR (INCOMPLETE — do not merge as-is):** ${prUrl}`, '',
        `Gate: ${s.gate?.summary || 'red'}`,
        `Spent $${rep.spent.toFixed(2)} in ${mins}m ${secs}s. The diff, the evidence and the remaining failures are in the PR.`,
      ] : [
        `${AGENT} opened a **draft** PR for this ticket.`,
        '', `**${prUrl}** -> \`${s.prTargetBranch}\`${updated ? ' _(updated — a run for this ticket had already opened it)_' : ''}`,
        ...extraPrs.map((x) => `${x.url} -> \`${x.target}\` — same branch, for testing on the lower environment`),
        '',
        evidenceLine,
        `Gate: ${s.gate?.summary || '—'}`,
        s.gate?.skipped?.length ? `Not run for the clock: ${s.gate.skipped.join(', ')} — CI on the PR covers it.` : '',
        `Files: ${(s.changed || []).map((f) => `\`${f}\``).join(', ')}`,
        `Spent $${rep.spent.toFixed(2)} in ${mins}m ${secs}s. **A human reviews and merges — the agent cannot.**`,
      ].filter(Boolean)
      await addComment(s.issueKey, lines.join('\n')).catch((e) => console.error(`jira comment failed: ${e.message}`))

      // Move the ticket. This used to be opt-in behind PAG_JIRA_TRANSITION and therefore never
      // happened: a PR would open and the ticket would sit in To Do until someone dragged it,
      // which is most of the manual work the automation was supposed to remove.
      //
      // It is on by default now, with a CANDIDATE LIST rather than one name, because "In Review" is
      // called four different things across boards and Jira only offers the transitions valid from
      // the ticket's current status. lib/jira.mjs matches the transition name or the destination
      // column, and logs everything that was on offer when nothing matches — which is the only
      // useful output when a board is named unusually.
      //
      // PAG_JIRA_TRANSITION overrides the list; PAG_JIRA_TRANSITION=off disables it.
      const configured = (process.env.PAG_JIRA_TRANSITION || '').trim()
      if (configured.toLowerCase() !== 'off') {
        const wanted = configured
          ? configured.split(',').map((x) => x.trim()).filter(Boolean)
          : (inc
            // A hand-over is not ready for review. Say it is being worked on, not that it is done.
            ? ['In Progress', 'In Development', 'Doing']
            : ['In Review', 'Code Review', 'Peer Review', 'Review', 'In QA', 'Ready for QA', 'In Progress'])
        const t = await transition(s.issueKey, wanted).catch((e) => ({ moved: false, reason: e.message, available: [] }))
        console.error(t.moved
          ? `jira: ${s.issueKey} moved to "${t.to}" (via "${t.via}")`
          : `jira: ${s.issueKey} not moved — ${t.reason}. Available from its current status: ${(t.available || []).join(' | ') || 'none'}`)
      }
    }

    return { pr, prUrl, branchName: branch, extraPrs }
  }
}
