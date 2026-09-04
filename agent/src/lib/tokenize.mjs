// Tokenizer.
//
// Two rules matter here:
//
//   1. Ticket text and file text MUST tokenize identically, or the scoring compares two
//      different vocabularies. Hence one module used by both sides.
//   2. Stopwords are NOT hard-coded. `baseTokenize` does splitting and stemming only;
//      the stopword set is derived from the corpus at index time (see stopwords.mjs) and
//      injected. A hand-written list is arbitrary, English-only, and rots as the
//      vocabulary drifts.

/** Split an identifier on camelCase / PascalCase / snake / kebab / dot boundaries. */
function splitIdentifier(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
}

/** Light suffix stripping. Deliberately not a real stemmer - false merges cost more than misses. */
function stem(t) {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3)
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2)
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y'
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2)
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1)
  return t
}

/**
 * Splitting + stemming only. No stopword filtering - that is the caller's job, using a
 * set derived from the corpus.
 * @returns {string[]} duplicates preserved (term frequency matters to BM25)
 */
export function baseTokenize(text) {
  if (!text) return []
  const out = []
  for (const raw of splitIdentifier(String(text))) {
    const t = raw.toLowerCase()
    if (t.length < 3) continue
    if (/^\d+$/.test(t)) continue
    // Hex blobs, uuids, sha fragments - never topical.
    if (t.length > 12 && /^[0-9a-f]+$/.test(t)) continue
    out.push(stem(t))
  }
  return out
}

/**
 * @param {Set<string>} stop derived stopword set
 * @returns {(text:string)=>string[]}
 */
export function makeTokenizer(stop) {
  if (!stop || !stop.size) return baseTokenize
  return (text) => baseTokenize(text).filter((t) => !stop.has(t))
}

/** Repeat tokens to give a field more weight in the bag-of-words. */
export function weighted(tokens, weight) {
  if (weight <= 1) return tokens
  const out = []
  for (let i = 0; i < weight; i++) out.push(...tokens)
  return out
}
