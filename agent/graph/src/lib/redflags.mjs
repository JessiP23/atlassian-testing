// Design red flags in ADDED product lines. pstack's /architect rule, applied to a bug fix: an escape
// hatch is the code admitting the design does not fit — `any`, a forced cast, a silenced lint or type
// error, a TODO left for someone else. One of these in a fix is not "style"; it is the moment to make
// the model re-think, so the gate fails on it and repair gets the exact line. Tests are exempt (mocks
// legitimately cast), and only lines this patch ADDED count — the surrounding file is not our ticket.

const FLAGS = [
  [/(?<![\w$])as\s+any\b/, 'as any'],
  [/:\s*any\b/, ': any'],
  [/\bas\s+unknown\s+as\b/, 'as unknown as'],
  [/@ts-ignore\b/, '@ts-ignore'],
  [/@ts-expect-error\b/, '@ts-expect-error'],
  [/eslint-disable/, 'eslint-disable'],
  [/\b(TODO|FIXME|HACK|XXX)\b/, 'TODO/FIXME'],
  [/\bconsole\.(log|debug)\(/, 'console.log'],
  [/\bdebugger\b/, 'debugger'],
]

export const isTestPath = (f) => /(^|\/)(__tests__|__mocks__|test-samples)\/|\.(test|spec|repro\.test)\.[cm]?[jt]sx?$/.test(f)

/**
 * @param {string} diff  unified diff (`git diff HEAD` plus any NEW FILE bodies appended by the caller)
 * @param {{exempt?: string[]}} opts  files to skip (the frozen repro spec)
 * @returns {{file:string,line:number,kind:string,text:string}[]}
 */
export function scanRedFlags(diff, { exempt = [] } = {}) {
  const out = []
  let file = null, line = 0, skip = false
  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.replace(/^\+\+\+ (b\/)?/, '').trim(); skip = file === '/dev/null' || isTestPath(file) || exempt.includes(file); continue }
    if (raw.startsWith('--- NEW FILE: ')) { file = raw.slice('--- NEW FILE: '.length).trim(); line = 0; skip = isTestPath(file) || exempt.includes(file); continue }
    if (raw.startsWith('--- ')) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
    if (hunk) { line = Number(hunk[1]) - 1; continue }
    if (!file || skip) continue
    // In a diff, added lines start with '+'; in an appended NEW FILE body every line is added.
    const added = raw.startsWith('+') ? raw.slice(1) : (line >= 0 && !raw.startsWith('-') && !raw.startsWith(' ') && !raw.startsWith('\\') ? raw : null)
    if (raw.startsWith('-')) continue
    line++
    if (added == null) continue
    if (/^\s*\/\//.test(added) && !/@ts-|eslint-disable|TODO|FIXME/.test(added)) continue
    for (const [re, kind] of FLAGS) if (re.test(added)) { out.push({ file, line, kind, text: added.trim().slice(0, 140) }); break }
  }
  return out
}

export const describeRedFlags = (found) =>
  found.map((f) => `${f.file}:${f.line}  ${f.kind}  →  ${f.text}`).join('\n')
