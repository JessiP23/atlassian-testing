// The preview URL: a link a human clicks to SEE the fix, pinned to the backend that carries it.
//
// Pioneer already has every piece of this; the agent only sequences them.
//
//   scripts/deploy/settings.sh   AP_VERSION_ID = md5(branch)[0:8]; in dev every stack, the AppSync
//                                API `ap-dev-<id>-api` and the pool `ap-dev-<id>-user-pool` are named by it
//   scripts/deploy/version.sh    --upsert POSTs that version's endpoints to the registry
//   web-app deploy:preview       builds with PREVIEW_ENV=true and copies the bundle to
//                                s3://ap-dev-web-app-preview-<account>/<SUBDOMAIN> behind the wildcard CloudFront
//   UnsecuredRoutes.tsx          when PREVIEW_ENV, /login reads the backend out of the QUERY STRING and
//                                writes it to cookies (this is what the Env Switcher's "copy URL" builds)
//
// So a preview link is (frontend build) × (backend chosen by query params) — two independent axes.
// That is what makes the evidence honest:
//
//   frontend fix  same backend (qa) on both links, the bundle differs  → the UI change is the only variable
//   backend fix   same bundle on both links, the version differs       → the Lambda change is the only variable
//
// Nothing here trusts a name: the endpoints always come from the registry the app itself reads.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { registryEntries } from '../nodes/deploy.mjs'

const exec = promisify(execFile)

export const AUTH_TYPE = process.env.PAG_PREVIEW_AUTH_TYPE || 'AMAZON_COGNITO_USER_POOLS'
export const REGION = process.env.PAG_PREVIEW_REGION || 'us-east-1'

/** A DNS-safe subdomain for one ticket's preview. Stable across reruns so a link keeps working. */
export function subdomainFor(issueKey, suffix = '') {
  const base = String(issueKey || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return (suffix ? `${base}-${suffix}` : base).slice(0, 60)
}

/**
 * The deep link the app understands. Field for field what EnvSwitcher's "copy URL" builds — including
 * `apiKey=<domainKey>`, which looks wrong and is what the client reads, so it is copied deliberately.
 */
export function deepLink(origin, entry) {
  if (!origin || !entry?.url || !entry?.userPoolId) return null
  const q = new URLSearchParams({
    apiKey: entry.domainKey || '',
    authenticationType: AUTH_TYPE,
    branch: entry.branch || '',
    developer: entry.developer || '',
    domainKey: entry.domainKey || '',
    graphqlEndpoint: entry.url,
    region: REGION,
    userPoolId: entry.userPoolId,
    userPoolWebClientId: entry.userPoolWebClientId || '',
  })
  return `${String(origin).replace(/\/$/, '')}/login?${q.toString()}`
}

/** The registry entry for a version id (the agent's backend) or a branch name ('qa'). */
export async function entryFor(idOrBranch, apis = null) {
  const list = apis || await registryEntries()
  if (!list) return null
  return list.find((a) => a.versionId === idOrBranch) || list.find((a) => a.branch === idOrBranch) || null
}

/**
 * Where preview bundles are served from. preview.sh picks the distribution whose CNAME is a wildcard;
 * the origin for a subdomain is that wildcard with the star replaced. Resolved from AWS, never guessed —
 * a wrong origin produces a link that 404s, which is worse than no link.
 */
export async function previewOrigin(env = process.env) {
  if (env.PAG_PREVIEW_DOMAIN) return `https://${String(env.PAG_PREVIEW_DOMAIN).replace(/^https?:\/\//, '').replace(/^\*\./, '')}`
  try {
    const { stdout } = await exec('aws', ['cloudfront', 'list-distributions', '--output', 'json'], { env, timeout: 60_000, maxBuffer: 1 << 26 })
    const items = JSON.parse(stdout)?.DistributionList?.Items || []
    // There is more than one wildcard: the preview domain (*.jessi-panda-app.com) and each deployed
    // version's own (*.238f0e42.jessi-panda-app.com). Preview bundles are served from the base one,
    // so take the SHORTEST — picking whichever came back first produced links that 404.
    const wild = items.map((d) => d.AliasICPRecordals?.[0]?.CNAME || '').filter((c) => c.startsWith('*.'))
      .map((c) => c.slice(2)).sort((a, b) => a.split('.').length - b.split('.').length || a.length - b.length)
    if (wild[0]) return `https://${wild[0]}`
  } catch { /* no credentials, or no distribution — the caller reports it as a skip */ }
  return null
}

/** Host the CURRENT working tree's frontend under <subdomain>. Returns { origin } or { error }. */
export async function deployPreview({ repo, subdomain, env, onProgress = () => {}, timeoutMs = 15 * 60_000 }) {
  try {
    onProgress(`preview: building and uploading the frontend as "${subdomain}"`)
    await exec('npx', ['nx', 'run', 'clients-web-app:deploy:preview'], {
      cwd: repo, env: { ...env, SUBDOMAIN: subdomain }, timeout: timeoutMs, maxBuffer: 1 << 26,
    })
  } catch (e) {
    return { error: String(e.stderr || e.message).slice(-600) }
  }
  const base = await previewOrigin(env)
  if (!base) return { error: 'the bundle uploaded but no wildcard CloudFront distribution was found to serve it' }
  const host = new URL(base).host
  return { origin: `https://${subdomain}.${host}` }
}
