// KAN-12 — main element uses fixed padding (64px horizontal / 128px vertical) at every viewport
// width, so on a 320px phone the content column collapses to ~192px and the headline stacks up.
// This witness walks the home page at 320px, then at 1280px, and judges each acceptance criterion.
import { test, expect, check, shot } from '/home/runner/work/atlassian-testing/atlassian-testing/agent/graph/witness/fixtures.mjs'

/** Padding, client box and content-column width of an element, as the browser computes them. */
const metrics = (el) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node)
    const padLeft = parseFloat(s.paddingLeft)
    const padRight = parseFloat(s.paddingRight)
    return {
      padLeft,
      padRight,
      padTop: parseFloat(s.paddingTop),
      padBottom: parseFloat(s.paddingBottom),
      contentWidth: node.clientWidth - padLeft - padRight,
    }
  })

/** How many rendered lines the headline occupies (height / line-height). */
const lineCount = (el) =>
  el.evaluate((node) => {
    const lh = parseFloat(getComputedStyle(node).lineHeight)
    return Math.round(node.getBoundingClientRect().height / lh)
  })

const documentOverflow = (page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))

test('KAN-12 home page main padding adapts to a 320px viewport', async ({ page }) => {
  const main = page.getByRole('main')
  const headline = page.getByRole('heading', { level: 1 })

  // ---- mobile: 320px wide ----
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/')
  await expect(main).toBeVisible()
  await expect(headline).toBeVisible()

  const mobile = await metrics(main)
  const mobileLines = await lineCount(headline)
  const mobileOverflow = await documentOverflow(page)
  console.log('MOBILE', JSON.stringify({ ...mobile, mobileLines, ...mobileOverflow }))

  // AC1 + AC2: horizontal padding at most 24px a side, leaving a content column of 270px or more.
  await check(page, '01-mobile-320-horizontal-padding', async () => {
    expect.soft(mobile.padLeft, 'main padding-left at 320px').toBeLessThanOrEqual(24)
    expect.soft(mobile.padRight, 'main padding-right at 320px').toBeLessThanOrEqual(24)
    expect.soft(mobile.contentWidth, 'main content column width at 320px').toBeGreaterThanOrEqual(270)
  })

  // AC4: vertical padding at most 64px top and bottom.
  await check(page, '02-mobile-320-vertical-padding', async () => {
    expect.soft(mobile.padTop, 'main padding-top at 320px').toBeLessThanOrEqual(64)
    expect.soft(mobile.padBottom, 'main padding-bottom at 320px').toBeLessThanOrEqual(64)
  })

  // AC3: the headline fits on two lines or fewer.
  await check(page, '03-mobile-320-headline-wrap', async () => {
    expect.soft(mobileLines, 'headline line count at 320px').toBeLessThanOrEqual(2)
  })

  // AC8: nothing spills sideways — no horizontal scrolling at 320px.
  await check(page, '04-mobile-320-no-horizontal-scroll', async () => {
    expect
      .soft(mobileOverflow.scrollWidth, 'document scrollWidth at 320px')
      .toBeLessThanOrEqual(mobileOverflow.clientWidth)
  })

  // ---- desktop: 1280px wide, layout must be untouched ----
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(main).toBeVisible()
  await shot(page, '05-desktop-1280-initial-load')

  const desktop = await metrics(main)
  const desktopLines = await lineCount(headline)
  console.log('DESKTOP', JSON.stringify({ ...desktop, desktopLines }))

  // AC5 + AC6: desktop padding stays exactly 64px horizontal and 128px vertical.
  await check(page, '06-desktop-1280-padding-unchanged', async () => {
    await expect.soft(main).toHaveCSS('padding-left', '64px')
    await expect.soft(main).toHaveCSS('padding-right', '64px')
    await expect.soft(main).toHaveCSS('padding-top', '128px')
    await expect.soft(main).toHaveCSS('padding-bottom', '128px')
  })

  // AC7: the desktop headline still occupies two lines.
  await check(page, '07-desktop-1280-headline-two-lines', async () => {
    expect.soft(desktopLines, 'headline line count at 1280px').toBe(2)
  })
})
