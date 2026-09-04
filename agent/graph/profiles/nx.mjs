// An nx monorepo (Pioneer). Owner projects come from the nearest project.json; type-surface
// changes fan out one level for build only; a single test file runs through the owning project's
// own jest config. This is the behaviour the graph shipped with — moved here so it is a choice.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const TYPE_SURFACE = /(\.graphql|\.d\.ts|\/types\.ts|\/index\.ts)$/

export default {
  // See profiles/nextjs.mjs. Pioneer has Playwright, so a witness spec ships as reviewable code.
  e2eDir: (repo) => 'e2e',

  name: 'nx',

  isUi: (p) => /^packages\/clients\/web-app\//.test(p),

  // 223 projects: baselining in-run is out of the question. bin/refresh.mjs does it per merge, for
  // the projects `nx affected` says a merge actually touched.
  baselineAll: false,

  ownerOf(repo, file) {
    let dir = path.dirname(path.join(repo, file))
    const stop = path.resolve(repo)
    while (dir.startsWith(stop) && dir !== stop) {
      const pj = path.join(dir, 'project.json')
      if (fs.existsSync(pj)) {
        try {
          const name = JSON.parse(fs.readFileSync(pj, 'utf8')).name
          if (name) return name
        } catch { /* malformed project.json — keep walking */ }
      }
      dir = path.dirname(dir)
    }
    return null
  },

  async typeConsumersFor(repo, changed, owners) {
    const surface = changed.filter((f) => TYPE_SURFACE.test(f))
    if (!surface.length || !owners.length) return []
    try {
      const { stdout } = await exec('npx', ['nx', 'show', 'projects', '--affected', `--files=${surface.join(',')}`], { cwd: repo, maxBuffer: 1 << 24 })
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean).filter((p) => !owners.includes(p))
    } catch {
      // nx unavailable or graph error: fail CLOSED to owners-only rather than silently widening.
      return []
    }
  },

  gate(repo, { owners = [], typeConsumers = [] } = {}) {
    const argvFor = (target, projects) => [
      'nx', 'run-many', '-t', target, '-p', projects.join(','), '--parallel=4',
      // Without --output-style=stream nx may print no per-test output; without --skip-nx-cache a
      // cached PASS can hide a real regression.
      '--output-style=stream', '--skip-nx-cache',
      ...(target === 'build' ? ['--configuration', 'production', '--exclude', 'tag:type:plugin'] : []),
      ...(target === 'lint' ? ['--quiet'] : []),
    ]
    return [
      { target: 'lint', projects: owners, argv: argvFor('lint', owners) },
      { target: 'test', projects: owners, argv: argvFor('test', owners) },                        // NEVER the closure
      { target: 'build', projects: [...owners, ...typeConsumers], argv: argvFor('build', [...owners, ...typeConsumers]) , exclusive: true, optional: true },
    ].filter((s) => s.projects.length)
  },

  // nx always has a test target; whether a GIVEN file has an owning project is testOne's question.
  hasUnitRunner: () => true,

  testOne(repo, specFile) {
    const project = this.ownerOf(repo, specFile)
    if (!project) return null
    return {
      project,
      argv: ['nx', 'run', `${project}:test`, `--testPathPattern=${specFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, '--output-style=stream', '--skip-nx-cache'],
      display: `npx nx run ${project}:test --testPathPattern=${specFile}`,
    }
  },

  /** Route/screen entry points of the web client, most specific first. */
  entryPoints(files) {
    const W = 'packages/clients/web-app/src'
    const rank = (p) =>
      new RegExp(`^${W}/(App|Router|routes)`).test(p) ? 0 :
      p.startsWith(`${W}/containers/`) ? 1 :
      p.startsWith(`${W}/pages/`) ? 1 :
      p.startsWith(`${W}/components/`) ? 2 : 9
    return files.filter((f) => rank(f.path) < 9).sort((a, b) => rank(a.path) - rank(b.path))
  },

  app: {
    argv: (port) => ['nx', 'run', 'clients-web-app:serve:development', `--port=${port}`, '--host=127.0.0.1'],
    defaultUrl: 'http://localhost:3000',
  },
}
