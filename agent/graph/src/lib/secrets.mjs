// Content scanning on the ADDED lines of the patch. The path guard (lib/guard.mjs) answers
// "which files may this run have changed"; this module answers "is there a credential INSIDE one
// of them", which no path list can catch.
//
// The gap this closes: guard.mjs denies `.env` and key files by path, so a run that writes
//     const client = new S3({ accessKeyId: 'AKIA...', secretAccessKey: '...' })
// into an allowed source file passes the guard, passes lint, passes the gate, and lands in a PR
// with a live credential in it. Nothing in the workflow looked at diff CONTENT.
//
// Two design rules, because a false positive here throws away a correct fix:
//
//   1. Only `+` lines of the real diff are scanned. Pre-existing secrets in the file are somebody
//      else's problem and must not fail this run — they would fail EVERY run, forever.
//   2. A finding needs a shape AND a value that could plausibly be real. `token: process.env.X`,
//      `password: ''`, `apiKey: 'changeme'` and `<your-key-here>` are how correct code looks;
//      flagging them trains the operator to ignore the scanner.

const PLACEHOLDER = /^(?:|x{3,}|y{3,}|z{3,}|0+|1+|changeme|change_me|placeholder|redacted|\[redacted\]|todo|tbd|none|null|undefined|example|sample|dummy|fake|test|testing|password|secret|token|foo|bar|baz|abc123|hunter2|s3cret)$/i

/** A value that is code, not a literal secret: an env read, a template hole, an import, a call. */
const NOT_A_LITERAL = /process\.env|import\.meta\.env|\$\{|<[^>]*>|getSecret|fromEnv|readFileSync|require\(|\.\.\./i

/** Shannon entropy per character — a real key is near 4+ bits, English prose is near 3. */
function entropy(s) {
  const f = new Map()
  for (const ch of s) f.set(ch, (f.get(ch) || 0) + 1)
  let h = 0
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p) }
  return h
}

const plausible = (v) => {
  const s = String(v || '').trim().replace(/^['"`]|['"`]$/g, '')
  if (s.length < 8) return false
  if (PLACEHOLDER.test(s)) return false
  if (NOT_A_LITERAL.test(s)) return false
  return true
}

// Ordered most-certain first. `value` is the capture group holding the candidate secret, or 0 for
// "the whole match is the secret".
const RULES = [
  { kind: 'aws-access-key-id', value: 0, re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'private-key', value: 0, re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: 'github-token', value: 0, re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/ },
  { kind: 'slack-token', value: 0, re: /\bxox[abpsr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'openai-or-stripe-key', value: 0, re: /\b(?:sk|pk|rk)-(?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{20,}/ },
  { kind: 'google-api-key', value: 0, re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'jwt', value: 0, re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'connection-string-password', value: 2, re: /\b([a-z][a-z0-9+.-]*):\/\/[^\s:@/]+:([^\s@/'"`]{6,})@/i },
  // A quoted literal assigned to a secret-shaped name. The name is the signal; `plausible()`
  // rejects the placeholder/env-read forms that make up most of these in real code.
  {
    kind: 'assigned-credential', value: 2,
    re: /\b((?:api[_-]?key|apikey|secret(?:[_-]?key|[_-]?access[_-]?key)?|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|passwd|password|pwd|bearer)\w*)\s*[:=]\s*['"`]([^'"`\n]{8,})['"`]/i,
  },
]

/** Files whose long random-looking strings are never credentials: hashes, sprites, fixtures. */
const IGNORE_FILE = /\.(?:css|scss|sass|less|svg|snap|lock|map|ico|png|jpe?g|webp|woff2?)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/

/** High-entropy quoted literal with no other explanation. Last resort, and the noisiest rule. */
function entropyHit(text) {
  for (const m of text.matchAll(/['"`]([A-Za-z0-9+/_=-]{32,})['"`]/g)) {
    const v = m[1]
    if (!plausible(v)) continue
    if (/^[0-9a-f]+$/i.test(v) && v.length % 8 === 0 && entropy(v) < 3.6) continue  // sha/md5 digest
    if (entropy(v) >= 4.0) return { kind: 'high-entropy-literal', value: v }
  }
  return null
}

/**
 * @param {string} text  one line (or any blob) of source
 * @returns {{kind:string, value:string}|null}
 */
export function scanText(text, { file = '' } = {}) {
  if (/pag-allow-secret/i.test(text)) return null      // explicit, reviewable, greppable opt-out
  for (const r of RULES) {
    const m = text.match(r.re)
    if (!m) continue
    const v = r.value === 0 ? m[0] : m[r.value]
    if (r.value !== 0 && !plausible(v)) continue
    return { kind: r.kind, value: String(v) }
  }
  if (!IGNORE_FILE.test(file)) return entropyHit(text)
  return null
}

/**
 * Scan the added lines of a unified diff.
 * @param {string} diff  output of `git diff HEAD` (plus appended new-file bodies)
 * @returns {{ok:boolean, findings:Array<{file:string,line:number,kind:string,excerpt:string}>}}
 */
export function scanDiff(diff) {
  const findings = []
  let file = '', line = 0
  for (const raw of String(diff || '').split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, '').trim(); line = 0; continue }
    if (raw.startsWith('--- NEW FILE: ')) { file = raw.slice(14).trim(); line = 0; continue }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) { line = Number(hunk[1]) - 1; continue }
    if (raw.startsWith('-')) continue
    // Context lines advance the counter but are NOT scanned: a pre-existing secret is not this
    // run's finding, and blaming the patch for it would make the scanner unusable.
    if (raw.startsWith(' ')) { line++; continue }
    const added = raw.startsWith('+') ? raw.slice(1) : raw
    line++
    if (IGNORE_FILE.test(file) && !/^-----BEGIN/.test(added)) continue
    const hit = scanText(added, { file })
    if (hit) {
      findings.push({
        file, line, kind: hit.kind,
        // Never echo the value: the refusal is written to a Jira comment and a job summary.
        excerpt: `${added.trim().slice(0, 60).replace(hit.value, '<' + hit.kind + '>')}`.slice(0, 90),
      })
    }
  }
  return { ok: findings.length === 0, findings }
}

export function formatFindings(findings) {
  return findings.map((f) => `- \`${f.file}:${f.line}\` — ${f.kind}: \`${f.excerpt}\``).join('\n')
}
