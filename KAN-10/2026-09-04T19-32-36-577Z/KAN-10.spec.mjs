// KAN-10 — witness: the root layout still ships create-next-app's default metadata, so the tab
// title, the description, and every Open Graph / Twitter tag a link unfurler reads are wrong.
//
// Everything asserted here lives in <head> of the public home page, which renders with no session.
// States, in the order a person meets them: the tab title, then the unfurl tags, then the image the
// unfurl points at, then the Twitter card, then the visible page (which must NOT change), then the
// preview card a crawler would build from the SERVER-rendered HTML.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, check, shot } from '/home/runner/work/atlassian-testing/atlassian-testing/agent/graph/witness/fixtures.mjs'

const REPO = '/home/runner/work/atlassian-testing/atlassian-testing'
const TITLE = 'Asset Panda — Internal Tools'
const DESCRIPTION = 'Internal tooling for asset lookup and check-out.'

/** content="" of <meta name=KEY> or <meta property=KEY>, as the live DOM has it. null when absent. */
const metaContent = (page, key) =>
  page.evaluate(
    (k) => document.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.getAttribute('content') ?? null,
    key,
  )

/** Same, but from raw server HTML — what an unfurler that runs no JavaScript actually sees. */
const metaFromHtml = (html, key) => {
  const tag = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${key}["'][^>]*>`, 'i'))?.[0]
  return tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? null
}

/** Does the og:image URL correspond to a real image file committed under public/ or app/? */
const imageFileInRepo = (url) => {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost:3000').pathname)
  const stem = path.basename(pathname).replace(/\.[^.]+$/, '')
  const direct = ['public', 'app'].map((dir) => path.join(REPO, dir, pathname))
  const hit = direct.find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
  if (hit) return path.relative(REPO, hit)
  const walk = (dir) =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p)
          return path.basename(e.name).replace(/\.[^.]+$/, '') === stem && stem ? [p] : []
        })
      : []
  const found = [...walk(path.join(REPO, 'public')), ...walk(path.join(REPO, 'app'))][0]
  return found ? path.relative(REPO, found) : null
}

test('KAN-10 home page ships real site metadata and social preview tags', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // AC 1 + AC 2 — the browser tab and the meta description.
  await check(page, '01-initial-load-title-and-description', async () => {
    await expect.soft(page).toHaveTitle(TITLE)
    expect.soft(await metaContent(page, 'description'), 'meta description').toContain(DESCRIPTION)
  })

  // AC 3 + AC 4 + AC 5 — the Open Graph tags every unfurler reads first.
  await check(page, '02-open-graph-tags', async () => {
    expect.soft(await metaContent(page, 'og:title'), 'og:title').toBe(TITLE)
    expect.soft(await metaContent(page, 'og:description'), 'og:description').toBe(DESCRIPTION)
    expect.soft(await metaContent(page, 'og:type'), 'og:type').toBe('website')
  })

  // AC 6 — og:image exists, is fetchable as an image, and is a file in this repository.
  await check(page, '03-og-image-resolves-to-repo-file', async () => {
    const src = await metaContent(page, 'og:image')
    expect.soft(src, 'og:image').not.toBeNull()
    if (src) {
      const res = await page.request.get(new URL(src, 'http://localhost:3000').toString())
      expect.soft(res.status(), `GET ${src}`).toBe(200)
      expect.soft(res.headers()['content-type'] ?? '', `content-type of ${src}`).toMatch(/^image\//)
      expect.soft(imageFileInRepo(src), `${src} resolved to a file under public/ or app/`).not.toBeNull()
    }
  })

  // AC 7 — the Twitter card type, so the preview renders large instead of as a bare link.
  await check(page, '04-twitter-card', async () => {
    expect.soft(await metaContent(page, 'twitter:card'), 'twitter:card').toBe('summary_large_image')
  })

  // AC 8 — metadata is head-only: the rendered page, its copy and its colours must not move.
  await check(page, '05-visible-page-unchanged', async () => {
    const main = page.getByRole('main')
    await expect.soft(main).toBeVisible()
    await expect.soft(page.getByRole('heading', { level: 1 })).toContainText('To get started, edit the')
    await expect.soft(page.getByText('page.tsx', { exact: true })).toBeVisible()
    await expect.soft(page.getByRole('link', { name: 'Templates' })).toBeVisible()
    await expect.soft(page.getByRole('link', { name: 'Learning' })).toBeVisible()
    await expect.soft(page.getByRole('link', { name: /Deploy Now/ })).toBeVisible()
    await expect.soft(page.getByRole('link', { name: 'Documentation' })).toBeVisible()
    await expect.soft(page.getByRole('img', { name: 'Next.js logo' })).toBeVisible()
    await expect.soft(main).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect.soft(page.getByRole('heading', { level: 1 })).toHaveCSS('color', 'rgb(0, 0, 0)')
  })

  // AC 9 — the preview Slack/Teams would build. Unfurlers run no JavaScript, so read the SERVER
  // HTML and paint it as a card: that card is the artefact a reviewer compares before vs after.
  const html = await (await page.request.get('/')).text()
  const card = {
    title: metaFromHtml(html, 'og:title') ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '(none)',
    description: metaFromHtml(html, 'og:description') ?? metaFromHtml(html, 'description') ?? '(none)',
    image: metaFromHtml(html, 'og:image') ?? '(none)',
    card: metaFromHtml(html, 'twitter:card') ?? '(none)',
  }
  const preview = await context.newPage()
  await preview.setContent(`<!doctype html><meta charset="utf-8">
    <body style="margin:0;padding:40px;background:#f4f5f7;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
      <div style="max-width:560px;background:#fff;border-left:4px solid #1264a3;border-radius:6px;padding:16px 20px;box-shadow:0 1px 4px rgba(0,0,0,.15)">
        <div style="color:#616061;font-size:13px;margin-bottom:8px">localhost:3000 — link preview as an unfurler sees it</div>
        <div style="color:#1264a3;font-weight:700;font-size:18px">${card.title}</div>
        <div style="color:#1d1c1d;margin-top:6px">${card.description}</div>
        <div style="color:#616061;font-size:13px;margin-top:12px">og:image ${card.image} · twitter:card ${card.card}</div>
      </div>
    </body>`)
  await check(preview, '06-crawler-link-preview', async () => {
    expect.soft(card.title, 'og:title in server HTML').toBe(TITLE)
    expect.soft(card.description, 'og:description in server HTML').toBe(DESCRIPTION)
    expect.soft(card.title, 'server HTML still advertises the create-next-app default').not.toMatch(/Create Next App/i)
    expect.soft(card.description, 'server HTML still advertises the create-next-app default').not.toMatch(/Generated by create next app/i)
  })

  await shot(page, '07-final-home-page')
})
