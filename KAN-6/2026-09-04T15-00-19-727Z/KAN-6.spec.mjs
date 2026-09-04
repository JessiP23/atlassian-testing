// KAN-6 — witness: theme toggle on the home page (/).
//
// Walks the whole flow a user would: land on / in light mode, toggle to dark, reload, toggle back to
// light, then arrive as a first-time visitor under prefers-color-scheme: dark and light. Every
// acceptance criterion is a soft assertion inside check(), so the run captures ALL states and still
// fails at the end if any criterion is unmet.
import { test, expect, check, shot } from '/home/runner/work/atlassian-testing/atlassian-testing/agent/graph/witness/fixtures.mjs'

const WHITE = 'rgb(255, 255, 255)' // --background in light mode (#ffffff)
const NEAR_BLACK = 'rgb(10, 10, 10)' // --background in dark mode (#0a0a0a)
const BLACK = 'rgb(0, 0, 0)' // text-black on the <h1> in light mode
const ZINC_50 = 'lab(98.26 0 0)' // dark:text-zinc-50 on the <h1>, as Chromium reports it

const FAST = { timeout: 4_000 } // keep the red run inside the 90s test budget

/** The theme choice as the page persisted it. */
const storedTheme = (page) => page.evaluate(() => window.localStorage.getItem('theme'))

/** class="..." on <html> right now. */
const htmlClass = (page) => page.evaluate(() => document.documentElement.className)

/**
 * What the very first painted frame looked like — captured by an init script that runs before any
 * page script. If the theme is only applied after hydration, the first frame shows the WRONG theme:
 * that is the flash of incorrect theme (criterion 6).
 */
async function firstFrame(page) {
  await page.waitForFunction(() => window.__pagFlash?.captured === true, null, { timeout: 5_000 }).catch(() => {})
  return page.evaluate(() => window.__pagFlash ?? { captured: false })
}

test('KAN-6: home page theme toggle — light/dark, persisted, no flash', async ({ page }) => {
  await page.addInitScript(() => {
    window.__pagFlash = { captured: false, htmlClass: null, bodyBg: null }
    requestAnimationFrame(() => {
      window.__pagFlash.captured = true
      window.__pagFlash.htmlClass = document.documentElement.className
      window.__pagFlash.bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : null
    })
  })

  const body = page.locator('body')
  const heading = page.getByRole('heading', { level: 1 })
  const toggle = page.getByRole('button', { name: 'Toggle theme' })

  // A first-time visitor whose OS asks for light.
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(heading).toBeVisible()

  // ── 01 · first load, no stored choice, OS prefers light ────────────────────────────────────────
  // Criteria 1 (icon button named 'Toggle theme', top-right), 3 (light background),
  // 5 (respects prefers-color-scheme on a first visit).
  await check(page, '01-initial-load-prefers-light', async () => {
    expect.soft(await storedTheme(page), 'no theme stored on a first visit').toBeNull()
    expect.soft(await htmlClass(page), 'no dark class when the OS prefers light').not.toMatch(/\bdark\b/)
    await expect.soft(body).toHaveCSS('background-color', WHITE)
    await expect.soft(heading).toHaveCSS('color', BLACK)
    await expect.soft(toggle, 'a visible "Toggle theme" button on the home page').toBeVisible({ timeout: 5_000 })
    const box = await toggle.boundingBox({ timeout: 3_000 }).catch(() => null)
    expect.soft(box, 'the "Toggle theme" button has a position on the page').not.toBeNull()
    if (box) {
      const vp = page.viewportSize()
      expect.soft(box.x + box.width / 2, 'toggle sits in the right half of the page').toBeGreaterThan(vp.width / 2)
      expect.soft(box.y, 'toggle sits near the top of the page').toBeLessThan(200)
    }
  })

  await toggle.click({ timeout: 5_000 }).catch(() => {}) // tolerant: keep walking if the button is missing

  // ── 02 · after clicking the toggle: dark ───────────────────────────────────────────────────────
  // Criteria 2 (class on <html>), 3 (rgb(10,10,10)), 4 (persisted), 7 (dark: classes follow the
  // class, not the media query — the OS still asks for light here).
  await check(page, '02-after-toggle-dark', async () => {
    expect.soft(await htmlClass(page), 'class="dark" on <html> after toggling').toMatch(/\bdark\b/)
    await expect.soft(body).toHaveCSS('background-color', NEAR_BLACK, FAST)
    await expect.soft(heading, 'dark: classes respond to class="dark", not prefers-color-scheme').toHaveCSS('color', ZINC_50, FAST)
    expect.soft(await storedTheme(page), 'localStorage.theme after toggling to dark').toBe('dark')
  })

  await page.reload()
  await expect(heading).toBeVisible()

  // ── 03 · reloaded: the stored choice is restored, with no flash ─────────────────────────────────
  // Criteria 6 (no flash of the wrong theme) and 8 (restored from localStorage after reload).
  await check(page, '03-reloaded-still-dark', async () => {
    const frame = await firstFrame(page)
    expect.soft(await storedTheme(page), 'localStorage.theme survives a reload').toBe('dark')
    expect.soft(await htmlClass(page), 'dark restored on reload').toMatch(/\bdark\b/)
    await expect.soft(body).toHaveCSS('background-color', NEAR_BLACK, FAST)
    expect.soft(frame.htmlClass, 'first painted frame already carries the dark class — no flash').toMatch(/\bdark\b/)
    expect.soft(frame.bodyBg, 'first painted frame already dark — no flash').toBe(NEAR_BLACK)
  })

  await toggle.click({ timeout: 5_000 }).catch(() => {})

  // ── 04 · toggled back to light ─────────────────────────────────────────────────────────────────
  // Criteria 2, 3 and 4 for the other side of the toggle.
  await check(page, '04-toggled-back-light', async () => {
    expect.soft(await htmlClass(page), 'dark class removed when toggling back').not.toMatch(/\bdark\b/)
    await expect.soft(body).toHaveCSS('background-color', WHITE, FAST)
    await expect.soft(heading).toHaveCSS('color', BLACK, FAST)
    expect.soft(await storedTheme(page), "localStorage.theme is 'light' after toggling back").toBe('light')
  })

  // A brand-new visitor whose OS asks for dark.
  await page.evaluate(() => window.localStorage.removeItem('theme'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await expect(heading).toBeVisible()

  // ── 05 · first visit, no stored choice, OS prefers dark ────────────────────────────────────────
  // Criteria 5 (respects prefers-color-scheme), 6 (no flash) and 7 (dark: classes follow the class).
  await check(page, '05-first-visit-prefers-dark', async () => {
    const frame = await firstFrame(page)
    expect.soft(await htmlClass(page), 'dark class applied from prefers-color-scheme').toMatch(/\bdark\b/)
    await expect.soft(body).toHaveCSS('background-color', NEAR_BLACK, FAST)
    await expect.soft(heading, 'dark: heading colour follows the class').toHaveCSS('color', ZINC_50, FAST)
    expect.soft(frame.htmlClass, 'first painted frame already dark — no flash').toMatch(/\bdark\b/)
  })

  await shot(page, '06-first-visit-prefers-dark-full')

  // Same brand-new visitor, OS asking for light.
  await page.evaluate(() => window.localStorage.removeItem('theme'))
  await page.emulateMedia({ colorScheme: 'light' })
  await page.reload()
  await expect(heading).toBeVisible()

  // ── 07 · first visit, no stored choice, OS prefers light ───────────────────────────────────────
  await check(page, '07-first-visit-prefers-light', async () => {
    expect.soft(await htmlClass(page), 'no dark class when the OS prefers light').not.toMatch(/\bdark\b/)
    await expect.soft(body).toHaveCSS('background-color', WHITE, FAST)
    await expect.soft(heading).toHaveCSS('color', BLACK, FAST)
  })
})
