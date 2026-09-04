// Credential redaction, applied at the fetch boundary.
//
// Asset Panda tickets routinely embed live test-account credentials in the description
// ("Test Account: someone@company.com / P@ssw0rd"). Those must never reach a cache file
// on disk, an LLM prompt, or a log line - and the redaction has to happen once, at the
// point text enters the system, not at each place it leaves.
//
// Redaction is intentionally aggressive. A false positive costs a few routing tokens; a
// false negative leaks a production password to a third party.

const PATTERNS = [
  // email / secret  or  email : secret  - the dominant shape in these tickets
  [/([\w.+-]+@[\w.-]+\.\w{2,})(\s*[/|:]\s*)(\S{4,})/g, (m, a, b) => `${a}${b}[REDACTED]`],

  // labelled secrets: password: x, pwd = x, token - x, api key: x, secret: x
  [/\b(pass(?:word|wd)?|pwd|token|api[\s_-]?key|secret|credential|auth)\b(\s*[:=-]\s*)(\S+)/gi,
    (m, a, b) => `${a}${b}[REDACTED]`],

  // Bearer / Basic auth headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{12,}/g, (m, a) => `${a} [REDACTED]`],

  // Long opaque blobs: JWTs, API keys, hex digests
  [/\beyJ[A-Za-z0-9._-]{20,}/g, () => '[REDACTED_JWT]'],
  [/\b[0-9a-fA-F]{32,}\b/g, () => '[REDACTED_HEX]'],
  [/\b(?:sk|gsk|pk|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{16,}/g, () => '[REDACTED_KEY]'],

  // AWS
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => '[REDACTED_AWS_KEY]'],

  // Emails themselves: never useful for routing, and they are personal data.
  [/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g, () => '[email]'],

  // Atlassian media blobs - pure noise, and they are long
  [/blob:https?:\/\/\S+/g, () => ''],
]

/**
 * @param {string} text
 * @returns {{text:string, redactions:number}}
 */
export function redact(text) {
  if (!text) return { text: '', redactions: 0 }
  let out = String(text)
  let count = 0
  for (const [re, fn] of PATTERNS) {
    out = out.replace(re, (...args) => {
      count++
      return fn(...args)
    })
  }
  return { text: out, redactions: count }
}

/**
 * Belt-and-braces check before text is sent to a third party. Returns the patterns that
 * still look secret-shaped, so a caller can refuse rather than send.
 */
export function residualSecrets(text) {
  const hits = []
  if (/\bP@\w{4,}/i.test(text)) hits.push('password-shaped literal')
  if (/\b[0-9a-fA-F]{32,}\b/.test(text)) hits.push('hex digest')
  if (/\beyJ[A-Za-z0-9._-]{20,}/.test(text)) hits.push('jwt')
  return hits
}
