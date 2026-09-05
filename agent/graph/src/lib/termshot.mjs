// Render a captured terminal session to a PNG.
//
// WHY: the reproducing test's red-then-green transcript is already in the PR as text, and text is
// the more useful artifact — you can copy it, search it, diff it. But a reviewer who did not run
// the command has only the agent's word that the text is what the terminal printed. A picture is
// not more trustworthy in principle; it is harder to fabricate casually, and it is what people
// actually look at. So: both. The text stays exactly as it was, and the image sits above it.
//
// No new dependency: Playwright and Chromium are already here for the browser witness. Rendering
// costs about a second per image.
//
// ANSI is converted rather than stripped, because a jest run's red ✕ and green ✓ carry the verdict.
// A monochrome dump of the same bytes loses the one thing a screenshot is good at.

import fs from 'node:fs'
import path from 'node:path'

// SGR codes worth honouring. Everything else is dropped rather than guessed at.
const FG = {
  30: '#3b4048', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#dcdfe4',
  90: '#5c6370', 91: '#e06c75', 92: '#98c379', 93: '#e5c07b', 94: '#61afef', 95: '#c678dd', 96: '#56b6c2', 97: '#ffffff',
}
const BG = { 40: '#282c34', 41: '#e06c75', 42: '#98c379', 43: '#e5c07b', 44: '#61afef', 45: '#c678dd', 46: '#56b6c2', 47: '#dcdfe4' }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** ANSI SGR -> HTML spans. Handles colour, bold, dim and reverse; ignores the rest. */
export function ansiToHtml(input) {
  let out = ''
  let open = 0
  const state = { fg: null, bg: null, bold: false, dim: false, reverse: false }
  const flush = () => { while (open > 0) { out += '</span>'; open-- } }
  const paint = () => {
    flush()
    const fg = state.reverse ? (state.bg || '#282c34') : state.fg
    const bg = state.reverse ? (state.fg || '#dcdfe4') : state.bg
    const style = [
      fg && `color:${fg}`,
      bg && `background:${bg};padding:0 3px;border-radius:2px`,
      state.bold && 'font-weight:700',
      state.dim && 'opacity:.65',
    ].filter(Boolean).join(';')
    if (style) { out += `<span style="${style}">`; open++ }
  }
  const text = String(input).replace(/\r\n/g, '\n').replace(/\r/g, '')
  const re = /\x1b\[([0-9;]*)m/g
  let last = 0, m
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index))
    last = re.lastIndex
    for (const raw of (m[1] || '0').split(';')) {
      const n = Number(raw || 0)
      if (n === 0) Object.assign(state, { fg: null, bg: null, bold: false, dim: false, reverse: false })
      else if (n === 1) state.bold = true
      else if (n === 2) state.dim = true
      else if (n === 7) state.reverse = true
      else if (n === 22) { state.bold = false; state.dim = false }
      else if (n === 27) state.reverse = false
      else if (n === 39) state.fg = null
      else if (n === 49) state.bg = null
      else if (FG[n]) state.fg = FG[n]
      else if (BG[n]) state.bg = BG[n]
    }
    paint()
  }
  out += esc(text.slice(last))
  flush()
  return out
}

/** Keep the interesting end of a long log — the failure and the summary live at the bottom. */
function tail(text, maxLines) {
  const lines = String(text).split('\n')
  if (lines.length <= maxLines) return lines.join('\n')
  return [`… ${lines.length - maxLines} earlier lines omitted`, '', ...lines.slice(-maxLines)].join('\n')
}

const page = (title, subtitle, body, accent) => `<!doctype html>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box }
  body { margin: 0; background: #14171c; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .win { margin: 18px; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 34px rgba(0,0,0,.5); border: 1px solid #2a2f38 }
  .bar { display: flex; align-items: center; gap: 10px; background: #21252b; padding: 9px 13px; border-bottom: 1px solid #2a2f38 }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .t { color: #9aa4b2; font: 600 12px/1 ui-monospace, monospace; letter-spacing: .02em }
  .badge { margin-left: auto; font: 700 11px/1 ui-monospace, monospace; letter-spacing: .08em;
           padding: 4px 8px; border-radius: 4px; color: #14171c; background: ${accent} }
  pre { margin: 0; padding: 14px 16px; color: #dcdfe4; background: #1b1f26; white-space: pre-wrap;
        word-break: break-word; tab-size: 2 }
  .sub { padding: 7px 16px; color: #6b7280; background: #191d23; border-bottom: 1px solid #23272f; font-size: 11.5px }
</style>
<div class="win">
  <div class="bar">
    <div class="dot" style="background:#ff5f57"></div><div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div>
    <div class="t">${esc(title)}</div>
    <div class="badge">${esc(accent === '#98c379' ? 'PASS' : 'FAIL')}</div>
  </div>
  <div class="sub">${esc(subtitle)}</div>
  <pre>${body}</pre>
</div>`

/**
 * Render one log to <runDir>/evidence/<name>.png.
 *
 * @param {{text:string, name:string, title:string, subtitle:string, pass:boolean, maxLines?:number}} o
 * @returns {Promise<string|null>} the file path, or null when it could not be rendered
 */
export async function termshot({ text, name, title, subtitle, pass, maxLines = 46 }) {
  const runDir = process.env.PAG_RUN_DIR
  if (!runDir || !String(text || '').trim()) return null
  if (process.env.PAG_TERMSHOT === '0') return null
  let browser
  try {
    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch()
    const p = await browser.newPage({ viewport: { width: 1180, height: 400 }, deviceScaleFactor: 2 })
    await p.setContent(page(title, subtitle, ansiToHtml(tail(text, maxLines)), pass ? '#98c379' : '#e06c75'), { waitUntil: 'load' })
    const dir = path.join(runDir, 'evidence')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${name}.png`)
    // fullPage so a long transcript is not cropped at the viewport.
    await p.screenshot({ path: file, fullPage: true })
    return file
  } catch {
    // A missing browser must never fail a run whose fix is already green. The text stays either way.
    return null
  } finally {
    try { await browser?.close() } catch { /* already gone */ }
  }
}
