// Corpus-derived stopwords.
//
// A hand-written stopword list is a liability: it is arbitrary, it is English-only, and it
// rots as the codebase and the ticket vocabulary drift. The principled version is
// document frequency - any token that appears in most files carries no power to
// discriminate between files, whatever language it is in and whether or not a human
// thought to list it.
//
// This runs over the index in milliseconds and produces a stopword set specific to YOUR
// repo. `component`, `service`, `handler` and `packages` get dropped automatically here
// because they are everywhere, and nobody had to decide that.

/**
 * @param {{path:string, exports:string[], imports:string[]}[]} files
 * @param {(s:string)=>string[]} tokenizeFn  base tokenizer (no stopword filtering)
 * @param {number} dfCeiling  drop tokens present in more than this fraction of files
 * @param {number} minDocs    also drop tokens appearing in fewer than this many files (typos, hashes)
 */
export function deriveStopwords(files, tokenizeFn, dfCeiling = 0.12, minDocs = 2) {
  const df = new Map()
  for (const f of files) {
    const seen = new Set()
    for (const t of tokenizeFn(f.path.replace(/\.[^.]+$/, '').replace(/\//g, ' '))) seen.add(t)
    for (const e of f.exports || []) for (const t of tokenizeFn(e)) seen.add(t)
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1)
  }
  const n = files.length || 1
  const stop = new Set()
  for (const [t, c] of df) {
    if (c / n > dfCeiling) stop.add(t)
    else if (c < minDocs) stop.add(t)
  }
  return { stop, df, n }
}

/**
 * Ticket-side stopwords: words common to MOST tickets say nothing about which ticket
 * this is. Derived from mined ticket text, so process words ("please", "customer",
 * "urgent", "reproduce") fall out on their own.
 *
 * @param {{text:string}[]} samples
 * @param {(s:string)=>string[]} tokenizeFn
 * @param {number} dfCeiling
 */
export function deriveTicketStopwords(samples, tokenizeFn, dfCeiling = 0.25) {
  const df = new Map()
  for (const s of samples) {
    const seen = new Set(tokenizeFn(s.text || ''))
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1)
  }
  const n = samples.length || 1
  const stop = new Set()
  for (const [t, c] of df) if (c / n > dfCeiling) stop.add(t)
  return { stop, df, n }
}
