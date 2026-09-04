// The Indexer. Builds a repo map: packages, files, exported symbols, import edges.
//
// Zero dependencies and zero LLM calls, on purpose. Everything here is derivable from
// the filesystem, so it is deterministic, free, and cannot hallucinate. An LLM-written
// "folder doc" layer can sit on top of this later, but it must not sit underneath it -
// the structural facts are what make the router's answers checkable.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { extractVocabulary, extractUiText } from './lib/symbols.mjs'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.nx', '.cache',
  // The agent's own source, when it is vendored into the repo it works on. Without this the
  // router spends candidates on the agent and can point the patch step at itself.
  ...(process.env.PAG_INDEX_EXCLUDE || 'agent').split(',').map((x) => x.trim()).filter(Boolean),
  'tmp', '.turbo', 'out', '.next', 'vendor', 'ios', 'android', 'Pods',
])

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/** Files that are real code but never the answer to "where do I fix this". */
const NOISE_RE = /(\.d\.ts|\.spec\.[tj]sx?|\.test\.[tj]sx?|\.stories\.[tj]sx?)$/

function walk(dir, root, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(full, root, out)
    } else if (e.isFile()) {
      const ext = path.extname(e.name)
      if (!SOURCE_EXT.has(ext)) continue
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (NOISE_RE.test(rel)) continue
      out.push(rel)
    }
  }
}

/** Discover packages from nx/lerna style project.json + package.json, without running nx. */
function findPackages(root) {
  const pkgs = []
  const seen = new Set()
  const scan = (dir, depth) => {
    if (depth > 5) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    const names = entries.map((e) => e.name)
    if (names.includes('project.json') || (names.includes('package.json') && dir !== root)) {
      const rel = path.relative(root, dir).split(path.sep).join('/')
      if (rel && !seen.has(rel)) {
        let name = rel
        let tags = []
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))
          if (pj.name) name = pj.name
          if (Array.isArray(pj.tags)) tags = pj.tags
        } catch {
          try {
            const pk = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
            if (pk.name) name = pk.name
          } catch { /* keep the path as the name */ }
        }
        seen.add(rel)
        pkgs.push({ name, root: rel, tags })
        return // do not descend into a package's own subpackages
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      scan(path.join(dir, e.name), depth + 1)
    }
  }
  scan(root, 0)
  return pkgs.sort((a, b) => b.root.length - a.root.length) // longest prefix wins
}

const EXPORT_RES = [
  /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  /export\s*\{([^}]*)\}/g,
]

const IMPORT_RE = /(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g
const GQL_OP_RE = /\b(?:query|mutation|subscription)\s+([A-Za-z_$][\w$]*)/g
const ROUTE_RE = /path:\s*['"]([^'"]+)['"]/g

/**
 * Regex extraction rather than a real AST. Deliberate for v1: zero install friction, and
 * it recovers the two things the router actually scores on - exported symbol names and
 * import targets. Swap in ts-morph or tree-sitter only if the eval says precision is the
 * bottleneck, because that decision should be data-driven, not aesthetic.
 */
function extract(abs) {
  let src
  try { src = fs.readFileSync(abs, 'utf8') } catch { return null }
  if (src.length > 400_000) src = src.slice(0, 400_000)

  const exports = new Set()
  for (const re of EXPORT_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) {
      for (const piece of m[1].split(',')) {
        const nm = piece.trim().split(/\s+as\s+/)[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(nm)) exports.add(nm)
      }
    }
  }

  const imports = new Set()
  IMPORT_RE.lastIndex = 0
  let mi
  while ((mi = IMPORT_RE.exec(src))) imports.add(mi[1])

  const gqlOps = new Set()
  GQL_OP_RE.lastIndex = 0
  let mg
  while ((mg = GQL_OP_RE.exec(src))) gqlOps.add(mg[1])

  // `path:` in source is assigned to plenty of things that are not URL routes -
  // OpenSearch field mappings, glob patterns, filesystem paths, config keys. Keep only
  // route-shaped values; the rest are noise at best and regex-hostile at worst.
  const routes = new Set()
  ROUTE_RE.lastIndex = 0
  let mr
  while ((mr = ROUTE_RE.exec(src))) {
    const v = mr[1]
    if (v.length < 2 || v.length > 120) continue
    if (!v.startsWith('/')) continue
    if (/[*?()[\]{}+^$\\|<>#%]/.test(v)) continue
    if (/\.(json|ya?ml|ts|tsx|js|jsx|png|svg|css|html)$/i.test(v)) continue
    if (!/^\/[A-Za-z0-9\-_/:.]*$/.test(v)) continue
    routes.add(v)
  }

  // Intra-file vocabulary. Before this, the index carried only a file's EXPORTED surface, so BM25
  // scored tickets against metadata rather than code — see lib/symbols.mjs for why that capped
  // any-hit@25 at 50%.
  const { symbols, strings } = extractVocabulary(src)
  const uiText = extractUiText(src)

  return {
    exports: [...exports].slice(0, 60),
    imports: [...imports].slice(0, 80),
    gqlOps: [...gqlOps].slice(0, 30),
    routes: [...routes].slice(0, 30),
    symbols,
    uiText,
    strings,
    loc: src.split('\n').length,
  }
}

function gitCommit(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch { return null }
}

/**
 * @param {string} repoRoot
 * @returns {{builtAt:string, repoRoot:string, commit:string|null, packages:any[], files:any[]}}
 */
export function buildIndex(repoRoot) {
  const root = path.resolve(repoRoot)
  const pkgs = findPackages(root)
  const rels = []
  walk(root, root, rels)

  const pkgOf = (rel) => {
    for (const p of pkgs) if (rel.startsWith(p.root + '/')) return p.name
    return '(root)'
  }

  const files = []
  for (const rel of rels) {
    const info = extract(path.join(root, rel))
    if (!info) continue
    files.push({ path: rel, pkg: pkgOf(rel), ...info })
  }

  return {
    builtAt: new Date().toISOString(),
    repoRoot: root,
    commit: gitCommit(root),
    packages: pkgs.sort((a, b) => a.root.localeCompare(b.root)),
    files,
  }
}
