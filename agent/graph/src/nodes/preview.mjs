// Publish a URL a human can click, and say exactly what it proves.
//
// A reviewer should not have to read a diff or trust a test to believe a fix. They should open two
// links, do the ticket's steps in both, and see the difference. This node produces that pair, and it
// changes ONE variable between them:
//
//   the fix is in the FRONTEND   both links point at the same backend (qa). The "before" link is qa's
//                                own app, the "after" link is this branch's bundle. Same data, same
//                                account, same backend — only the code that renders the page differs.
//   the fix is in the BACKEND    both links serve the SAME bundle from this branch. The "before" link
//                                pins qa's AppSync, the "after" pins the version the deploy node just
//                                pushed these Lambdas to. Only the Lambda code differs.
//
// It never invents a link. Every endpoint comes from the registry the app itself reads, and if the
// bundle cannot be hosted the node reports why and the run continues — a missing preview is a missing
// convenience, not a failed fix.
import { loadProfile } from '../../profiles/index.mjs'
import { isTestFile } from '../lib/guard.mjs'
import { ciDeployCredentials, exportCredentials, envWithoutStaticKeys, versionIdFor, registryEntries } from './deploy.mjs'
import { subdomainFor, deepLink, entryFor, deployPreview } from '../lib/preview.mjs'

const BASELINE_BRANCH = process.env.PAG_PREVIEW_BASELINE || 'qa'

export function previewNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const skip = (reason) => { onProgress(`preview skipped: ${reason}`); return { preview: { status: 'skipped', reason } } }
    if (process.env.PAG_PREVIEW !== '1') return skip('PAG_PREVIEW is not 1')
    if (!s.gate?.ok) return skip('the gate is not green — there is nothing worth hosting')
    if (!(s.changed || []).length) return skip('no files changed')

    const creds = ciDeployCredentials() || await exportCredentials()
    if (!creds) return skip('no AWS credentials for the dev account (set PAG_DEPLOY_ROLE_ARN in CI, or run `aws sso login` locally)')
    const { arn, ...credEnv } = creds
    const env = { ...envWithoutStaticKeys(), ...credEnv, CDK_DISABLE_NOTICES: '1', FORCE_COLOR: '0', NX_DAEMON: 'false' }

    const profile = loadProfile(s.repo)
    const product = (s.changed || []).filter((f) => !isTestFile(f))
    const isBackendFix = product.some((f) => !profile.isUi?.(f))
    // Which backend carries the fix: the version the deploy node pushed to, or qa when the fix is
    // entirely in the page. A backend fix with no successful deploy has no honest "after" backend.
    const fixedId = isBackendFix ? (s.backend?.status === 'deployed' ? s.backend.versionId || versionIdFor(s.issueKey) : null) : BASELINE_BRANCH
    if (isBackendFix && !fixedId) {
      return skip(`the fix is in the backend and it was not deployed (${s.backend?.reason || s.backend?.status || 'deploy did not run'}) — a link would show the unpatched backend and read as proof of nothing`)
    }

    const t0 = Date.now()
    const apis = await registryEntries()
    if (!apis) return skip('the version registry is unreachable')
    const fixed = await entryFor(fixedId, apis)
    const before = await entryFor(BASELINE_BRANCH, apis)
    if (!fixed) return skip(`the registry does not list ${fixedId} — run \`npm run version:upsert\` for it`)

    const subdomain = subdomainFor(s.issueKey)
    const { origin, error } = await deployPreview({ repo: s.repo, subdomain, env, onProgress })
    budget.exclude(Date.now() - t0)   // a static upload is a build, not model time
    if (error) return skip(`the frontend could not be hosted: ${error}`)

    const afterUrl = deepLink(origin, fixed)
    // Frontend fix: "before" is qa's OWN app, so the bundle is the only difference. Backend fix:
    // "before" is this same bundle pinned to qa, so the Lambdas are the only difference.
    const beforeUrl = isBackendFix
      ? (before ? deepLink(origin, before) : null)
      : (process.env.PAG_QA_APP_URL || null)

    onProgress(`preview: ${afterUrl ? 'fixed ' + afterUrl.split('?')[0] : 'no link'}${beforeUrl ? ' · before link too' : ''}`)
    return {
      preview: {
        status: 'ready', origin, subdomain, layer: isBackendFix ? 'backend' : 'frontend',
        after: { url: afterUrl, versionId: fixed.versionId, branch: fixed.branch, developer: fixed.developer },
        before: beforeUrl ? { url: beforeUrl, versionId: before?.versionId || BASELINE_BRANCH, branch: before?.branch || BASELINE_BRANCH } : null,
        minutes: Number(((Date.now() - t0) / 60_000).toFixed(1)),
      },
    }
  }
}

/** The block that opens the PR body. Written for someone who will not read the diff. */
export function previewBlock(s) {
  const p = s.preview
  if (!p || p.status !== 'ready' || !p.after?.url) return ''
  const steps = (s.spec?.acceptanceCriteria || []).slice(0, 3).map((x, i) => `${i + 1}. ${String(x).replace(/^\d+[.)]\s*/, '')}`)
  const lines = ['## See it yourself', '']
  if (p.before?.url) {
    lines.push(
      `| | link | what it runs |`,
      `|---|---|---|`,
      `| **Before** | [open the broken version](${p.before.url}) | ${p.layer === 'backend' ? `this branch's UI on the **${p.before.branch}** backend — the fix is *not* deployed there` : `**${p.before.branch}** as it is today`} |`,
      `| **After** | [open the fixed version](${p.after.url}) | ${p.layer === 'backend' ? `the same UI on backend version **${p.after.versionId}**, where this patch's Lambdas are deployed` : `this branch's UI on the same **${p.after.branch}** backend`} |`,
      '',
      p.layer === 'backend'
        ? '_Both links serve the same frontend build. The only difference between them is the Lambda code behind it, so anything that changes is this patch._'
        : '_Both links talk to the same backend and the same data. The only difference between them is the page, so anything that changes is this patch._',
      '',
    )
  } else {
    lines.push(`[Open the fixed version](${p.after.url}) — this branch's UI on ${p.layer === 'backend' ? `backend version **${p.after.versionId}**` : `the **${p.after.branch}** backend`}.`, '')
  }
  if (steps.length) lines.push('Do the same thing in both:', '', ...steps, '')
  lines.push('_The link pins the backend for you; you do not need to pick one in the Env Switcher._')
  return lines.join('\n')
}
