// Turn gate output into STRUCTURED failures: {tool, file, line, col, rule, message}.
//
// Why this exists: repair.mjs used to receive `logTail: out.slice(-8000)` — the last 8 KB of a
// tool's stdout. On a lint failure the last 8 KB is the summary footer and the next 40 files'
// warnings; the one error's file and line are thousands of characters earlier and often truncated
// out entirely. So the repair session's first two minutes went to re-running the gate itself to
// find out what had failed, with Opus, inside the node's own time slice.
//
// Parsing is cheap, deterministic and testable, so it happens here once and repair gets told
// exactly which rule broke at which file:line. The raw tail still travels as a fallback for the
// cases below that nothing matches.

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')

// nx prefixes every line of a task's output with `project: `. Strip it or nothing matches.
//
// The prefix pattern must EXCLUDE dots, or it eats the file path off the front of every line it
// was meant to help with: `app/page.tsx:12:5 - error TS2322` became `12:5 - error TS2322` and both
// tsc parsers stopped matching (caught by test/gatelog.test.mjs, which is the whole reason the
// tests exist). nx project names have no dots — `clients-web-app`, `@ap/shared` — and nx always
// puts a space after the colon, so both are required here.
const denx = (s) => s.replace(/^[\w@/-]+:\s/, '')

const PATHY = /^\.?\/?(?:[\w.@-]+\/)*[\w.@-]+\.(?:[cm]?[tj]sx?|json|graphql|css|scss)$/

/**
 * @param {string} out    combined stdout+stderr of one gate command
 * @param {string} target 'lint' | 'typecheck' | 'build' | 'test' | 'repro'
 * @returns {Array<{tool:string,file:string,line:number,col:number,rule:string,message:string}>}
 */
export function parseGateFailures(out, target = '') {
  const lines = strip(out).split('\n').map(denx)
  const found = []
  const push = (f) => {
    if (!f.file || found.length >= 40) return
    f.file = f.file.replace(/^\.\//, '')
    if (found.some((g) => g.file === f.file && g.line === f.line && g.rule === f.rule)) return
    found.push({ tool: target, line: 0, col: 0, rule: '', message: '', ...f })
  }

  let current = ''            // ESLint stylish: a bare path line, then indented `l:c  error  msg  rule`
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const t = l.trim()

    // ---- ESLint (stylish, and `next lint`, which prefixes the path with ./) ------------------
    if (PATHY.test(t)) { current = t; continue }
    const styl = t.match(/^(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s\s+([\w@/-]+))?$/)
    if (styl && current) {
      if (styl[3] === 'error') push({ tool: 'eslint', file: current, line: +styl[1], col: +styl[2], rule: styl[5] || '', message: styl[4].trim() })
      continue
    }
    // `next lint` compact: "./app/page.tsx" then "12:5  Error: msg  rule"
    const nextl = t.match(/^(\d+):(\d+)\s+Error:\s+(.+?)(?:\s\s+([\w@/-]+))?$/)
    if (nextl && current) { push({ tool: 'eslint', file: current, line: +nextl[1], col: +nextl[2], rule: nextl[4] || '', message: nextl[3].trim() }); continue }

    // ---- tsc: both spellings --------------------------------------------------------------
    const tsc1 = t.match(/^(\S+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s*(.+)$/)
    if (tsc1) { push({ tool: 'tsc', file: tsc1[1], line: +tsc1[2], col: +tsc1[3], rule: tsc1[4], message: tsc1[5] }); continue }
    const tsc2 = t.match(/^(\S+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s*(.+)$/)
    if (tsc2) { push({ tool: 'tsc', file: tsc2[1], line: +tsc2[2], col: +tsc2[3], rule: tsc2[4], message: tsc2[5] }); continue }

    // ---- next build: "./app/page.tsx:12:5" on one line, "Type error: ..." a few lines down --
    const loc = t.match(/^\.?\/?([\w./@-]+\.[cm]?[tj]sx?):(\d+):(\d+)$/)
    if (loc) {
      const msg = lines.slice(i + 1, i + 6).map((x) => x.trim()).find((x) => /^(Type error|Error|ReferenceError|SyntaxError):/.test(x))
      if (msg) { push({ tool: 'build', file: loc[1], line: +loc[2], col: +loc[3], rule: msg.split(':')[0], message: msg.replace(/^[^:]+:\s*/, '') }); continue }
    }

    // ---- jest: "● suite › case" then the assertion, then "at file:line:col" ----------------
    const jest = t.match(/^●\s+(.+)$/)
    if (jest && !/●\s+Console/.test(t)) {
      const block = lines.slice(i + 1, i + 30).map((x) => x.trim())
      // Not just the first matching line: jest puts the matcher on one line and the values two
      // lines below (`expect(received).toBe(expected)` / `Expected: "AP-1042"` / `Received: undefined`).
      // The values ARE the failure; the matcher name alone tells repair nothing it can act on.
      const from = block.findIndex((x) => /^(Expected|expect\(|Received|Unable to find|TypeError|ReferenceError)/.test(x))
      const assertion = from === -1 ? '' : block.slice(from)
        .filter((x) => x && !/^at\s/.test(x))
        .slice(0, 4)
        .join(' · ')
      // `.*?\(` must be LAZY: greedy backtracking happily captured `t.tsx` out of
      // `at Object.<anonymous> (app/import/ImportErrorRow.test.tsx:22:31)` and reported that as
      // the file, which sent repair to a path that does not exist.
      const at = block.map((x) => x.match(/^at\s+(?:.*?\()?([\w./@-]+\.[cm]?[tj]sx?):(\d+):(\d+)\)?$/)).find(Boolean)
      push({ tool: 'jest', file: at ? at[1] : '', line: at ? +at[2] : 0, col: at ? +at[3] : 0, rule: jest[1].slice(0, 120), message: assertion.slice(0, 300) })
      continue
    }

    // ---- Playwright list reporter: "✘  1 KAN-6.spec.mjs:12:5 › name" -----------------------
    const pw = t.match(/^[✘×]\s+\d+\s+\[?[\w-]*\]?\s*›?\s*([\w./@-]+\.[cm]?[tj]sx?):(\d+):(\d+)\s*›\s*(.+)$/)
    if (pw) {
      const msg = lines.slice(i + 1, i + 12).map((x) => x.trim()).find((x) => /^(Error|expect|Expected|Timed out)/.test(x)) || ''
      push({ tool: 'playwright', file: pw[1], line: +pw[2], col: +pw[3], rule: pw[4].slice(0, 120), message: msg.slice(0, 300) })
      continue
    }
    // The soft-assertion form fixtures.check() produces: "[02-after-toggle-dark] <message>"
    const soft = t.match(/^\[(\d\d-[\w-]+)\]\s+(.+)$/)
    if (soft) { push({ tool: 'playwright', file: 'witness', line: 0, rule: soft[1], message: soft[2].slice(0, 300) }); continue }
  }
  return found
}

/** What repair is handed instead of a log tail. Grouped by file so the edits are obvious. */
export function formatFailures(failures) {
  if (!failures?.length) return ''
  const byFile = new Map()
  for (const f of failures) {
    const k = f.file || '(no file)'
    if (!byFile.has(k)) byFile.set(k, [])
    byFile.get(k).push(f)
  }
  return [...byFile.entries()].map(([file, fs_]) => [
    `### ${file}`,
    ...fs_.slice(0, 12).map((f) => `- ${f.line ? `line ${f.line}${f.col ? ':' + f.col : ''} — ` : ''}${f.rule ? `\`${f.rule}\` ` : ''}${f.message || ''}`.trim()),
  ].join('\n')).join('\n\n')
}

/** One-line summary for the gate verdict and the PR footer. */
export function summariseFailures(failures) {
  if (!failures?.length) return ''
  const files = [...new Set(failures.map((f) => f.file).filter(Boolean))]
  const rules = [...new Set(failures.map((f) => f.rule).filter(Boolean))].slice(0, 3)
  return `${failures.length} failure(s) in ${files.length} file(s)${rules.length ? ` (${rules.join(', ')})` : ''}`
}
