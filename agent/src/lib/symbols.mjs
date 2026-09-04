// Intra-file vocabulary extraction. The Phase 1 retrieval fix.
//
// WHY THIS EXISTS
// The index used to carry only a file's EXPORTED names, its imports, its GraphQL ops and its route
// strings. Nothing from inside the file. So BM25 was scoring tickets against metadata, not against
// code — which is why any-hit@25 sat at 50% while a 137M-parameter trained retriever reaches 66%
// at k=5 (SweRank) and Agentless reaches 81% file-level. That was never a method ceiling; the
// method was starved.
//
// The clearest case is the ticket this system was built on. ESI2-3376 is "Import Failing with no
// error logs" against a Categories collection. The culprit is `upload-to-import-s3.ts`, whose
// decisive tokens are STRING LITERALS:
//
//     const path = importTemplateId ? 'updateImports' : collectionId === 'category' ? 'categoryImports' : …
//
// `categoryImports` and `updateImports` appear nowhere in that file's exports (`uploadToImportS3`),
// its path segments, or its imports. Under the old index the one file that answers the ticket was
// close to unreachable by lexical means. Indexing literals connects ticket prose — "categories
// import" — straight to the branch that mishandles it.
//
// TWO CHANNELS, DIFFERENT JOBS
//   symbols  every DECLARED identifier, not just exported ones: functions, consts, classes, types,
//            interfaces, enums, methods. This is the "function-granular" part — a 900-line file
//            stops being one undifferentiated bag of words.
//   strings  literals that carry meaning: error messages, status values, i18n keys, path prefixes,
//            discriminant values. Bug tickets quote these more often than they quote symbol names.
//
// Regex, not a real parser, deliberately: the whole indexer is zero-dependency and rebuilds 6,262
// files in ~2s. `ts-morph` would give better precision at the cost of a heavyweight dependency and
// a much slower rebuild. BM25 is robust to a few false identifiers; it is not robust to having no
// identifiers at all. If precision ever becomes the binding constraint, swap this file — nothing
// else needs to change.

// Declarations. Each capture is a name being DEFINED here, which is what makes it evidence of
// ownership rather than of use.
const DECL_RES = [
  /\b(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  /^\s*(?:public|private|protected|readonly|static|\s)*([a-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/gm, // class methods
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/gm,                                           // object-literal fns
  /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,                                  // arrow assignments
]

// Literals worth indexing. Template literals are included because error messages are usually
// interpolated; the static fragments are still the searchable part.
const STRING_RES = [
  /'((?:[^'\\\n]|\\.){2,120})'/g,
  /"((?:[^"\\\n]|\\.){2,120})"/g,
  /`((?:[^`\\$]|\\.){2,120})`/g,
]

// Literals that are structure, not meaning. Indexing these adds noise and inflates document
// frequency, which pushes the genuinely rare tokens down.
const STRING_NOISE = [
  /^[./@~]/,                       // module specifiers and relative paths
  /^[A-Z_]+$/,                     // SCREAMING_CASE env keys — already covered by declarations
  /^\d+(\.\d+)?$/,                 // bare numbers
  /^#?[0-9a-fA-F]{3,8}$/,          // colours
  /^(?:utf-?8|application\/json|GET|POST|PUT|DELETE|PATCH|true|false|null|undefined)$/i,
  /^[\s\W]+$/,                     // punctuation and whitespace only
  /^(?:px|rem|em|%|auto|none|flex|block|inline|absolute|relative|hidden|solid)$/i, // css atoms
  /\{\{|\}\}/,                     // template placeholders
];

/** Class/JSX-attribute soup: long space-separated lowercase runs are Tailwind, not prose. */
const looksLikeClassNames = (s) =>
  s.split(/\s+/).length > 3 && /^[a-z0-9:\-\s/[\]().%]+$/.test(s)

/**
 * @param {string} src  file source
 * @returns {{symbols:string[], strings:string[]}}
 */
export function extractVocabulary(src) {
  const symbols = new Set()
  for (const re of DECL_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) {
      const name = m[1]
      // 1-2 char names are loop counters and destructuring noise; they match everything.
      if (name && name.length > 2 && !/^(?:the|and|for|let|var|new|ret|res|req|err|idx|tmp)$/.test(name)) {
        symbols.add(name)
      }
    }
  }

  const strings = new Set()
  for (const re of STRING_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) {
      const raw = m[1]
      if (!raw) continue
      const s = raw.trim()
      if (s.length < 3 || s.length > 120) continue
      if (STRING_NOISE.some((n) => n.test(s))) continue
      if (looksLikeClassNames(s)) continue
      strings.add(s)
    }
  }

  // Caps keep the index a similar size to before. Declarations are ordered by appearance, which
  // roughly tracks importance in these files (top-level exports and types come first).
  return {
    symbols: [...symbols].slice(0, 120),
    strings: [...strings].slice(0, 80),
  }
}

// ---- visible UI text -------------------------------------------------------------------------
//
// The third channel, and the one that answers a UI ticket. `strings` captures quoted literals —
// classNames, URLs, i18n keys — but the words a reporter actually types are the words they SAW on
// screen, and those are JSX TEXT, not string literals:
//
//     <a className="...">Deploy Now</a>
//
// "Deploy Now" appears in no export, no import, no path segment and no string literal, so a ticket
// about that button is lexically unreachable. This channel indexes what a user can read: JSX text
// nodes, and the attributes that render as text (alt, aria-label, placeholder, title, label).
//
// Kept deliberately narrow — human-facing phrases only, capped per file — because the measured
// negative result on whole-file vocabulary (any-hit@25 fell 1-2pp) came from flooding BM25 with
// document frequency. This is matched as a PHRASE, not summed as terms.
const JSX_TEXT = />([^<>{}]{2,80})</g
const TEXT_ATTR = /\b(?:alt|aria-label|placeholder|title|label)\s*=\s*["']([^"']{2,80})["']/g
export function extractUiText(src, { cap = 80 } = {}) {
  const out = new Set()
  const add = (raw) => {
    const t = String(raw).replace(/\s+/g, ' ').trim()
    if (t.length < 2 || t.length > 80) return
    if (!/[A-Za-z]/.test(t)) return                     // punctuation / numbers only
    if (/^[{}()[\];,.:]+$/.test(t)) return
    if (/^(https?:|\/\/|#|&\w+;)/.test(t)) return         // urls, entities
    if (/[<>]/.test(t)) return
    // Tailwind-ish class soup and code-looking tokens are not something a person reads out loud.
    if (/^[a-z0-9:\-\[\]/.]+$/.test(t) && !t.includes(' ')) return
    if (/(^|\s)(flex|grid|text-|bg-|dark:|sm:|md:|lg:|rounded|border|px-|py-|gap-|w-|h-)/.test(t) && /\s/.test(t)) return
    out.add(t)
  }
  for (const m of src.matchAll(JSX_TEXT)) add(m[1])
  for (const m of src.matchAll(TEXT_ATTR)) add(m[1])
  return [...out].slice(0, cap)
}
