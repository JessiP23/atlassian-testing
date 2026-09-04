// Okapi BM25. ~60 lines, no dependencies, and for "which file does this ticket touch"
// it is a genuinely strong baseline - strong enough that you should not pay for
// embeddings until you have beaten it and measured the difference.

const K1 = 1.2
const B = 0.75

export class BM25 {
  constructor() {
    /** @type {string[]} */
    this.ids = []
    /** @type {Map<string, Map<number, number>>} term -> docIndex -> termFreq */
    this.postings = new Map()
    /** @type {number[]} */
    this.lengths = []
    this.avgLen = 0
  }

  /**
   * @param {string} id
   * @param {string[]} tokens
   */
  add(id, tokens) {
    const d = this.ids.length
    this.ids.push(id)
    this.lengths.push(tokens.length)
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
    for (const [t, f] of tf) {
      let p = this.postings.get(t)
      if (!p) { p = new Map(); this.postings.set(t, p) }
      p.set(d, f)
    }
  }

  finalize() {
    const n = this.lengths.length
    this.avgLen = n ? this.lengths.reduce((a, b) => a + b, 0) / n : 0
    return this
  }

  /**
   * @param {string[]} queryTokens
   * @returns {Map<string, number>} id -> score (only non-zero scores)
   */
  score(queryTokens) {
    const N = this.ids.length
    const acc = new Map() // docIndex -> score
    const qtf = new Map()
    for (const t of queryTokens) qtf.set(t, (qtf.get(t) || 0) + 1)

    for (const t of qtf.keys()) {
      const p = this.postings.get(t)
      if (!p) continue
      const df = p.size
      // +1 inside the log keeps the idf non-negative for terms in most documents.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (const [d, f] of p) {
        const norm = 1 - B + B * (this.lengths[d] / (this.avgLen || 1))
        const s = idf * ((f * (K1 + 1)) / (f + K1 * norm))
        acc.set(d, (acc.get(d) || 0) + s)
      }
    }

    const out = new Map()
    for (const [d, s] of acc) out.set(this.ids[d], s)
    return out
  }
}
