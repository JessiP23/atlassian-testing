// Pairing the two witness runs for the PR table. Extracted from nodes/publish.mjs so it can be
// unit-tested, because this is the one piece of presentation logic that has already been wrong in
// a way a reviewer noticed.
//
// THE BUG IT FIXES: the first version paired the before-shots and after-shots BY INDEX. The two
// runs do not produce the same number of frames — before the fix the flow breaks partway and the
// spec captures 3 states, after the fix it completes and captures 8 — so index pairing put
// `01-initial-load` next to `03-reloaded` and the table silently lied about what changed.
//
// The state NAME is the contract (witness/fixtures.mjs makes every `check()` shoot `NN-state`), so
// the name is the join key. A state the broken build never reached is shown as exactly that, which
// is itself evidence: "the toggle never rendered" is the bug, stated as a gap in the table.

/** `before-02-after-toggle-dark.png` -> `02-after-toggle-dark` */
export const stateKey = (f) => String(f).replace(/^(?:before|after)-/, '').replace(/\.png$/, '')

/** `02-after-toggle-dark` -> `after toggle dark` */
export const stateLabel = (k) => String(k).replace(/^\d+[-_]?/, '').replace(/[-_]+/g, ' ').trim() || String(k)

/**
 * @param {string[]} beforeShots  file names from the RED run
 * @param {string[]} afterShots   file names from the GREEN run
 * @param {number} limit          how many rows the PR table shows
 * @returns {{rows:Array<{key:string,label:string,before:string|null,after:string|null}>, missingBefore:string[], missingAfter:string[]}}
 */
export function pairShots(beforeShots = [], afterShots = [], limit = 8) {
  const B = new Map(beforeShots.map((f) => [stateKey(f), f]))
  const A = new Map(afterShots.map((f) => [stateKey(f), f]))
  const keys = [...new Set([...B.keys(), ...A.keys()])].sort()
  return {
    rows: keys.slice(0, limit).map((key) => ({ key, label: stateLabel(key), before: B.get(key) || null, after: A.get(key) || null })),
    missingBefore: keys.filter((k) => !B.has(k)),
    missingAfter: keys.filter((k) => !A.has(k)),
  }
}
