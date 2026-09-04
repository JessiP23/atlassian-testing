// A single-package app (Next.js / Vite / CRA). One logical project, npm scripts for the gate,
// no unit-test runner by default — so a UI ticket is proven by the Playwright witness and a
// non-UI ticket ships as evidence:none with the gate behind it.

import fs from 'node:fs'
import path from 'node:path'

const has = (repo, script) => {
  try { return Boolean(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts?.[script]) } catch { return false }
}
const hasDep = (repo, dep) => {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
    return Boolean(p.dependencies?.[dep] || p.devDependencies?.[dep])
  } catch { return false }
}

export default {
  name: 'nextjs',

  // Everything rendered is UI here, so any page/component/style change can be witnessed.
  isUi: (p) => /^(app|src|pages|components|styles)\//.test(p) && /\.(tsx|jsx|ts|js|css|scss)$/.test(p),

  // One project. Keeps the per-project baseline store and the scoped gate working unchanged.
  ownerOf: () => 'app',

  // One small package: running the whole gate on the clean checkout costs under a minute, so a run
  // can record its own baseline and never blame the patch for a failure that was already there.
  baselineAll: true,
  typeConsumersFor: () => [],

  gate(repo) {
    const plan = []
    if (has(repo, 'lint')) plan.push({ target: 'lint', projects: ['app'], argv: ['npm', 'run', '--silent', 'lint'] })
    if (fs.existsSync(path.join(repo, 'tsconfig.json'))) plan.push({ target: 'typecheck', projects: ['app'], argv: ['npx', 'tsc', '--noEmit'] })
    if (has(repo, 'test')) plan.push({ target: 'test', projects: ['app'], argv: ['npm', 'run', '--silent', 'test'] })
    if (has(repo, 'build')) plan.push({ target: 'build', projects: ['app'], argv: ['npm', 'run', '--silent', 'build'] })
    return plan
  },

  // No jest/vitest in a starter app: the unit rung is unavailable, and reproduce goes to the
  // witness for UI files. Wire this up the moment the repo gains a test runner.
  testOne(repo, specFile) {
    if (hasDep(repo, 'jest')) return { project: 'app', argv: ['jest', '--runTestsByPath', specFile], display: `npx jest --runTestsByPath ${specFile}` }
    if (hasDep(repo, 'vitest')) return { project: 'app', argv: ['vitest', 'run', specFile], display: `npx vitest run ${specFile}` }
    return null
  },

  /**
   * Where the user's journey starts. Used only when phrase, term and graph seeds all come back
   * empty — a structural fact about the app, not a guess, and one import hop from here covers a
   * small app completely.
   */
  entryPoints(files) {
    const rank = (p) =>
      /^(src\/)?app\/page\.[tj]sx?$/.test(p) ? 0 :
      /^(src\/)?app\/.*page\.[tj]sx?$/.test(p) ? 1 :
      /^(src\/)?pages\/index\.[tj]sx?$/.test(p) ? 1 :
      /^(src\/)?app\/layout\.[tj]sx?$/.test(p) ? 2 :
      /^(src\/)?(pages|app|components|containers)\//.test(p) ? 3 : 9
    return files.filter((f) => rank(f.path) < 9).sort((a, b) => rank(a.path) - rank(b.path))
  },

  // `next dev` is the right server for the witness: it hot-reloads, so the SAME spec re-runs
  // against the patched code without a rebuild.
  app: {
    argv: (port) => ['npm', 'run', '--silent', 'dev', '--', '--port', String(port)],
    defaultUrl: 'http://localhost:3000',
  },
}
