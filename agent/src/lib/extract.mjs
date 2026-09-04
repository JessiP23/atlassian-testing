// Hard-signal extraction from ticket text.
//
// This is the answer to "tickets are all different". BM25 treats every word as equally
// fuzzy evidence, which is right for a vague UX complaint and badly wrong for a ticket
// that pastes a stack trace. A stack trace naming `useCollectionRecordsTQ.ts` is not
// evidence - it is the answer, and it should not have to compete with word statistics.
//
// So: pull the near-certain identifiers out first, score them separately, and let BM25
// handle only what is left. Different ticket shapes hit different extractors, which is
// what makes this dynamic without anyone maintaining per-ticket-type rules.

/** Framework/lib paths that appear in every stack trace and mean nothing about your code. */
const VENDOR_RE = /(node_modules|webpack|vite\/|chunk-|react-dom|\.vite\/deps)/

const RES = {
  // src/foo/bar.tsx, packages/x/y.ts, ./relative/path.js - with or without line:col
  filePath: /(?:^|[\s('"`[])((?:\.{0,2}\/)?(?:[\w.-]+\/){0,12}[\w.-]+\.(?:tsx?|jsx?|mjs|cjs))(?::\d+)?/g,
  // Backtick or quote-wrapped identifiers - how humans cite code in tickets
  quoted: /[`'"]([A-Za-z_$][\w$.]{2,60})[`'"]/g,
  // useFoo / FooBar / fooBarBaz - identifier-shaped words in prose
  identifier: /\b((?:use|get|set|fetch|handle|on|is|has|create|update|delete)[A-Z][\w$]{2,}|[A-Z][a-z]+(?:[A-Z][\w$]+)+)\b/g,
  // Error/Exception class names
  errorClass: /\b([A-Z][\w$]*(?:Error|Exception|Warning))\b/g,
  // URL paths, incl. localhost and app routes: /home/xyz/collections/abc
  urlPath: /(?:https?:\/\/[^\s/]+)?(\/[a-z0-9][a-z0-9\-_]*(?:\/[a-zA-Z0-9\-_:.]+){1,8})/g,
  // GraphQL operation names as they appear in network panels or logs
  gqlOp: /\b(?:query|mutation|subscription)\s+([A-Za-z_$][\w$]*)|\b(get[A-Z]\w+|create[A-Z]\w+|update[A-Z]\w+|delete[A-Z]\w+)\s*\(/g,
}

function collect(text, re, group = 1) {
  const out = new Set()
  re.lastIndex = 0
  let m
  while ((m = re.exec(text))) {
    const v = m[group] || m[group + 1]
    if (v) out.add(v)
  }
  return [...out]
}

/**
 * @param {string} text raw ticket text (summary + description + comments)
 * @returns {{filePaths:string[], symbols:string[], errorClasses:string[], urlPaths:string[], gqlOps:string[]}}
 */
export function extractSignals(text) {
  if (!text) return { filePaths: [], symbols: [], errorClasses: [], urlPaths: [], gqlOps: [] }

  const filePaths = collect(text, RES.filePath).filter((p) => !VENDOR_RE.test(p))

  const symbols = new Set()
  for (const v of collect(text, RES.quoted)) {
    // A quoted thing with a dot and an extension is a path, not a symbol.
    if (/\.(tsx?|jsx?|mjs|cjs|json|md)$/.test(v)) continue
    symbols.add(v.split('.')[0])
  }
  for (const v of collect(text, RES.identifier)) symbols.add(v)

  const errorClasses = collect(text, RES.errorClass)
  for (const e of errorClasses) symbols.delete(e) // scored on their own channel

  const urlPaths = collect(text, RES.urlPath).filter(
    // Drop asset and API noise; keep app routes.
    (p) => !/\.(png|jpe?g|svg|css|js|woff2?|ico)$/.test(p) && p.length > 3
  )

  const gqlOps = collect(text, RES.gqlOp)

  return {
    filePaths: filePaths.slice(0, 40),
    symbols: [...symbols].slice(0, 60),
    errorClasses: errorClasses.slice(0, 10),
    urlPaths: urlPaths.slice(0, 20),
    gqlOps: gqlOps.slice(0, 20),
  }
}

/** True when the ticket carries at least one high-precision identifier. */
export function hasHardSignal(sig) {
  return sig.filePaths.length > 0 || sig.gqlOps.length > 0 || sig.symbols.length > 0
}
