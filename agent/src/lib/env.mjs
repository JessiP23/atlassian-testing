// Zero-dependency .env loader.
//
// Loads .env then .env.local (local wins). The FILE takes precedence over variables already
// exported in the shell - see the comment at the assignment below for why that is deliberate.
// Containers have no .env file, so their env vars are used unchanged.

import fs from 'node:fs'
import path from 'node:path'

function parse(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let val = line.slice(eq + 1).trim()

    // ORDER MATTERS. Strip the trailing comment FIRST, then unquote — the reverse fails on the
    // very common shape
    //     JIRA_API_TOKEN="ATATT..."   # id.atlassian.com/manage-profile/security/api-tokens
    // because the trimmed value does not END with a quote (it ends with the comment), so a
    // quoted-value check runs first sees "not quoted", strips the comment, and leaves the QUOTES
    // in the value. Two stray characters in an auth header, and Jira answers 401 on every call
    // while the token in the file is perfectly good.
    //
    // Comment rule follows bash: '#' opens a comment only at the start of the value or after
    // whitespace, so `abc#def` keeps its '#'. Inside quotes, nothing is a comment.
    const q = val[0]
    if (q === '"' || q === "'") {
      const close = val.indexOf(q, 1)
      // Unterminated quote: fall through to the unquoted path rather than silently keeping it.
      if (close !== -1) {
        val = val.slice(1, close)
        out[key] = val
        continue
      }
    }
    const c = val.match(/(^|\s)#/)
    if (c) val = val.slice(0, c.index).trim()
    // A value that was quoted with no comment still needs unwrapping.
    if (val.length > 1 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** @param {string} [dir] directory to look in (default cwd) */
export function loadEnv(dir = process.cwd()) {
  const loaded = []
  // Names the file DEFINED that the environment already had — i.e. the file's value was ignored.
  // Exported here so tooling can say so out loud: a shell that ran `set -a; source .env` earlier
  // keeps shadowing every later edit to that file, which reads as "my new credential doesn't work".
  loadEnv.shadowed = loadEnv.shadowed || new Set()
  for (const name of ['.env', '.env.local']) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    const vars = parse(fs.readFileSync(file, 'utf8'))
    for (const [k, v] of Object.entries(vars)) {
      // THE FILE WINS. This was the opposite for one afternoon and it produced four separate
      // incidents that all looked like different bugs: an expired SSO profile beating good static
      // keys (ExpiredTokenException), stale interactively-exported keys beating rotated ones
      // (invalid security token), and a token edited in the file that was never read at all.
      //
      // "Real environment beats the file" is the right rule for a container, where config arrives
      // as env vars and there is no file. It is the wrong rule for a checkout with a .env in it,
      // because a variable exported once in a shell then silently outranks every later edit — and
      // the failure surfaces somewhere else entirely, as a 401 or a 403, never as "your shell is
      // shadowing this". In ECS there is no .env file, so this rule never applies there.
      //
      // Set PAG_ENV_PRECEDENCE=env to invert it for one command.
      const envWins = process.env.PAG_ENV_PRECEDENCE === 'env'
      if (process.env[k] !== undefined && process.env[k] !== v) {
        loadEnv.shadowed.add(k)          // recorded either way, so it can be reported
        if (envWins) continue
      }
      process.env[k] = v
    }
    loaded.push(name)
  }
  return loaded
}
