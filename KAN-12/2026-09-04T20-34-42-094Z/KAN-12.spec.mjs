import { test, expect, check, shot } from '/home/runner/work/atlassian-testing/atlassian-testing/agent/graph/witness/fixtures.mjs'

// KAN-12 — <main> padding must shrink on small viewports (320px: max 24px horizontal, 64px
// vertical) while the desktop layout is untouched (1280px: 64px horizontal, 128px vertical).
//
// The one <main> on the landing page carries `py-32 px-16` unconditionally, so a 320px phone
// spends 128px of its 320px width on padding and the headline is squeezed into a narrow column.

const HEADLINE = /To get started, edit the\s+page\.tsx\s+file\./

/** Padding, content-column width and headline line count, straight from the rendered box model. */
async function metrics(page) {
  const main = page.getByRole('main')
  await expect(main).toBeVisible()
  return await main.evaluate((el) => {
    const s = getComputedStyle(el)
    const h1 = el.querySelector('h1')
    const hs = getComputedStyle(h1)
    const lineHeight = parseFloat(hs.lineHeight)
    const doc = document.documentElement
    return {
      padLeft: parseFloat(s.paddingLeft),
      padRight: parseFloat(s.paddingRight),
      padTop: parseFloat(s.paddingTop),
      padBottom: parseFloat(s.paddingBottom),
      contentWidth: el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
      headlineLines: Math.round(h1.getBoundingClientRect().height / lineHeight),
      headlineLineHeight: lineHeight,
      headlineColor: hs.color,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
    }
  })
}

test('KAN-12 <main> padding shrinks at 320px and is unchanged at 1280px', async ({ page }) => {
  // ---------- small viewport ----------
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(HEADLINE)

  const small = await metrics(page)
  console.log('320px metrics', JSON.stringify(small))

  await check(page, '01-mobile-320-main-padding', async () => {
    expect.soft(small.padLeft, 'left padding at 320px').toBeLessThanOrEqual(24)
    expect.soft(small.padRight, 'right padding at 320px').toBeLessThanOrEqual(24)
    expect.soft(small.padTop, 'top padding at 320px').toBeLessThanOrEqual(64)
    expect.soft(small.padBottom, 'bottom padding at 320px').toBeLessThanOrEqual(64)
  })

  await check(page, '02-mobile-320-content-column', async () => {
    expect.soft(small.contentWidth, 'content column width at 320px').toBeGreaterThanOrEqual(270)
    expect.soft(small.headlineLines, 'headline line count at 320px').toBeLessThanOrEqual(2)
  })

  await check(page, '03-mobile-320-no-horizontal-scroll', async () => {
    expect.soft(small.docScrollWidth, 'document scrollWidth at 320px').toBeLessThanOrEqual(small.docClientWidth)
  })

  // ---------- desktop viewport: must be completely unchanged ----------
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(HEADLINE)

  const desktop = await metrics(page)
  console.log('1280px metrics', JSON.stringify(desktop))

  await check(page, '04-desktop-1280-main-padding', async () => {
    expect.soft(desktop.padLeft, 'left padding at 1280px').toBe(64)
    expect.soft(desktop.padRight, 'right padding at 1280px').toBe(64)
    expect.soft(desktop.padTop, 'top padding at 1280px').toBe(128)
    expect.soft(desktop.padBottom, 'bottom padding at 1280px').toBe(128)
  })

  await check(page, '05-desktop-1280-headline-two-lines', async () => {
    expect.soft(desktop.headlineLines, 'headline line count at 1280px').toBe(2)
  })

  // ---------- copy, colours and element order are unchanged ----------
  await check(page, '06-desktop-1280-copy-and-order-unchanged', async () => {
    await expect.soft(page.getByRole('img', { name: 'Next.js logo' })).toBeVisible()
    await expect.soft(page.getByRole('heading', { level: 1 })).toHaveText(HEADLINE)
    await expect.soft(page.getByText(/Looking for a starting point or more instructions\?/)).toBeVisible()
    await expect.soft(page.getByRole('link', { name: 'Templates' })).toBeVisible()
    await expect.soft(page.getByRole('link', { name: 'Learning' })).toBeVisible()
    await expect.soft(page.getByRole('link', { name: /Deploy Now/ })).toBeVisible()
    await expect.soft(page.getByRole('link', { name: 'Documentation' })).toBeVisible()
    await expect.soft(page.getByRole('main')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    expect.soft(desktop.headlineColor, 'headline colour at 1280px').toBe('rgb(0, 0, 0)')

    const order = await page.evaluate(() =>
      [...document.querySelector('main').children].map((c) => c.tagName.toLowerCase()),
    )
    expect.soft(order, 'element order inside main').toEqual(['img', 'div', 'div'])
  })

  await shot(page, '07-desktop-1280-full-page')
})
