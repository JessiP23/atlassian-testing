import { test, expect, check, shot } from '/home/runner/work/atlassian-testing/atlassian-testing/agent/graph/witness/fixtures.mjs'

// KAN-11: asset lookup on the home page. A GET route handler searches hard-coded assets
// (tag, name, location) case-insensitively; the home page shows a labelled search input above the
// existing content, a list of results, a loading message, a no-matches message, and on failure an
// error message with a Retry button that re-runs the same query.
//
// Everything the ticket does not pin down is probed rather than guessed: the query parameter name,
// the JSON envelope, and the forced-failure switch each have a candidate list, and the spec uses
// whichever one the implementation actually answers to.

const API = /\/api\/assets\/search/
const PARAM_NAMES = ['q', 'query', 'search', 'term', 's', 'tag']
const ENVELOPE_KEYS = ['results', 'assets', 'data', 'items', 'matches']
const KNOWN_TAGS = ['AP-1001', 'AP-1002', 'AP-2010', 'AP-2011', 'AP-3300']

const LOADING = /loading|searching|please wait/i
const NO_MATCHES = /no (matching|matches|results|assets|asset|items)|nothing (found|matched)|not found|no results/i
const ERROR_TEXT = /error|failed|failure|something went wrong|could ?n.t|unable|try again/i

/** Pull the row array out of whatever envelope the route returns. */
function rowsOf(body) {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    for (const key of ENVELOPE_KEYS) if (Array.isArray(body[key])) return body[key]
  }
  return null
}

function tagsOf(rows) {
  return (rows || []).map((r) => String(r?.tag ?? '')).filter(Boolean)
}

/** Find the query parameter the route reads: it must match on a real tag and miss on nonsense. */
async function findParam(page) {
  for (const param of PARAM_NAMES) {
    const hit = await get(page, param, 'ap-1001')
    if (!hit.ok || !hit.rows?.length) continue
    if (!tagsOf(hit.rows).some((t) => /AP-1001/i.test(t))) continue
    const miss = await get(page, param, 'zzqqxx-no-such-asset')
    if (miss.ok && miss.rows && miss.rows.length === 0) return param
  }
  return null
}

async function get(page, param, value, headers) {
  const res = await page.request.get(`/api/assets/search?${param}=${encodeURIComponent(value)}`, { headers })
  const body = await res.json().catch(() => null)
  return { status: res.status(), ok: res.ok(), body, rows: rowsOf(body) }
}

/** The labelled search input (criterion 4), with a role fallback so a miss is reported by the assertion. */
function searchInput(page) {
  return page.getByLabel(/search|look ?up|asset|tag/i).or(page.getByRole('searchbox')).first()
}

async function runSearch(page, query) {
  const input = searchInput(page)
  await input.waitFor({ state: 'visible', timeout: 5_000 })
  await input.fill(query)
  const submit = page.getByRole('button', { name: /^(search|look ?up|find|go)\b/i }).first()
  if (await submit.count()) await submit.click()
  else await input.press('Enter')
}

test('KAN-11 asset lookup on the home page', async ({ page }) => {
  const apiCalls = []
  page.on('request', (req) => { if (API.test(req.url())) apiCalls.push(req.url()) })

  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // Learn the route's contract up front so the UI checks can assert real names and locations.
  const param = await findParam(page)
  const seed = new Map()
  if (param) {
    for (const probe of ['a', 'e', 'i', 'o', 'u', '-', '0', '1', '2', '3']) {
      const { rows } = await get(page, param, probe)
      for (const row of rows || []) if (row?.tag) seed.set(String(row.tag), row)
    }
  }
  const asset = (tag) => [...seed.values()].find((r) => String(r.tag).toUpperCase() === tag)

  await check(page, '01-initial-load', async () => {
    // Criterion 4: a labelled search input, above the existing home page content.
    const input = searchInput(page)
    await expect.soft(input).toBeVisible({ timeout: 5_000 })
    expect.soft(await page.getByLabel(/search|look ?up|asset|tag/i).count(), 'search input has a label').toBeGreaterThan(0)
    // Criterion 11: the existing content is still there, and still below the lookup.
    const heading = page.getByRole('heading', { level: 1 })
    await expect.soft(heading).toContainText(/to get started, edit the/i)
    await expect.soft(page.getByRole('link', { name: /deploy now/i })).toBeVisible()
    await expect.soft(page.getByRole('link', { name: /documentation/i })).toBeVisible()
    const box = await input.boundingBox().catch(() => null)
    const headingBox = await heading.boundingBox()
    expect.soft(box?.y ?? Number.POSITIVE_INFINITY, 'lookup sits above the existing content').toBeLessThan(headingBox.y)
  })

  // Criterion 6: a loading message while the request is in flight. The response is held back so the
  // in-flight state is observable, then released; the message must disappear on completion.
  await page.route(API, async (route) => {
    const res = await route.fetch().catch(() => null)
    await new Promise((r) => setTimeout(r, 2_500))
    if (res) await route.fulfill({ response: res })
    else await route.abort()
  }, { times: 1 })

  await check(page, '02-loading-in-flight', async () => {
    await runSearch(page, 'ap')
    await expect.soft(page.getByText(LOADING).first(), 'loading message while in flight').toBeVisible({ timeout: 8_000 })
  })

  await check(page, '03-results-for-lowercase-ap', async () => {
    // Criteria 2, 3, 5: a lowercase query lists every seeded AP asset with tag, name and location.
    for (const tag of KNOWN_TAGS) {
      await expect.soft(page.getByText(tag, { exact: false }).first(), `${tag} listed`).toBeVisible({ timeout: 8_000 })
    }
    const first = asset('AP-1001')
    if (first) {
      await expect.soft(page.getByText(String(first.name), { exact: false }).first()).toBeVisible()
      await expect.soft(page.getByText(String(first.location), { exact: false }).first()).toBeVisible()
    }
    const listish =
      (await page.getByRole('listitem').count()) + (await page.getByRole('row').count())
    expect.soft(listish, 'results rendered as a list').toBeGreaterThan(0)
    // Criterion 6: the loading message is gone once the request completed.
    expect.soft(await page.getByText(LOADING).count(), 'loading message cleared').toBe(0)
  })

  await check(page, '04-no-matches', async () => {
    // Criterion 7: a no-matches message, in words.
    await runSearch(page, 'zzqqxx-no-such-asset')
    await expect.soft(page.getByText(NO_MATCHES).first(), 'no-matches message').toBeVisible({ timeout: 8_000 })
    expect.soft(await page.getByText(/AP-\d{4}/).count(), 'no stale results left on screen').toBe(0)
  })

  // Criterion 8: the failing request. Forced at the network layer so the spec does not depend on
  // the shape of the route's own force-failure switch (that is asserted separately, in 07).
  let failNext = true
  await page.route(API, async (route) => {
    if (!failNext) return route.continue()
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'forced failure' }) })
  })

  await check(page, '05-request-failed', async () => {
    await runSearch(page, 'ap-2010')
    await expect.soft(page.getByText(ERROR_TEXT).first(), 'error message').toBeVisible({ timeout: 8_000 })
    await expect.soft(page.getByRole('button', { name: /retry|try again/i }), 'Retry button').toBeVisible({ timeout: 8_000 })
  })

  await check(page, '06-after-retry-succeeds', async () => {
    // Criterion 9: Retry re-runs the same search with the same query.
    failNext = false
    const before = apiCalls.length
    await page.getByRole('button', { name: /retry|try again/i }).first().click({ timeout: 5_000 })
    await expect.soft(page.getByText('AP-2010', { exact: false }).first(), 'result after retry').toBeVisible({ timeout: 8_000 })
    const replays = apiCalls.slice(before).filter((u) => /ap-2010/i.test(u))
    expect.soft(replays.length, 'Retry re-requested the same query').toBeGreaterThan(0)
    expect.soft(await page.getByRole('button', { name: /retry|try again/i }).count(), 'error state cleared').toBe(0)
  })

  await page.unroute(API)
  await shot(page, '07-home-page-after-flow')

  await check(page, '08-route-contract', async () => {
    // Criterion 1: the route exists and answers with tag / name / location.
    expect.soft(param, `GET /api/assets/search reads one of ${PARAM_NAMES.join(', ')}`).not.toBeNull()
    const rows = param ? (await get(page, param, 'ap-1001')).rows : null
    expect.soft(rows?.length ?? 0, 'a tag query matches').toBeGreaterThan(0)
    for (const field of ['tag', 'name', 'location']) {
      expect.soft(typeof rows?.[0]?.[field], `result has a ${field}`).toBe('string')
    }
    // Criterion 3: all six seeded assets, including the five tags the ticket names.
    const tags = [...seed.keys()].map((t) => t.toUpperCase())
    for (const tag of KNOWN_TAGS) expect.soft(tags, `seed contains ${tag}`).toContain(tag)
    expect.soft(tags.length, 'six seeded assets').toBeGreaterThanOrEqual(6)

    // Criterion 2: case-insensitive, matching anywhere in name and in location too.
    const sample = asset('AP-1001')
    if (sample && param) {
      const mid = (s) => String(s).slice(1, Math.max(2, String(s).length - 1)).toLowerCase()
      const byName = await get(page, param, mid(sample.name))
      expect.soft(tagsOf(byName.rows).map((t) => t.toUpperCase()), 'matches inside name, case-insensitively').toContain('AP-1001')
      const byLocation = await get(page, param, mid(sample.location))
      expect.soft(tagsOf(byLocation.rows).map((t) => t.toUpperCase()), 'matches inside location, case-insensitively').toContain('AP-1001')
    }

    // Criterion 10: a switch that forces the route to fail, for testing.
    const switches = [
      ...['fail', 'forceFail', 'forceError', 'forcefail', 'forceerror', 'error', 'simulateError', 'simulateFailure', 'forceFailure', 'testFail', 'mockError', 'boom']
        .flatMap((k) => ['1', 'true'].map((v) => ({ label: `?${k}=${v}`, extra: `&${k}=${v}`, headers: undefined }))),
      ...['x-force-error', 'x-force-fail', 'x-force-failure', 'x-simulate-error', 'x-test-error', 'x-fail']
        .flatMap((h) => ['1', 'true'].map((v) => ({ label: `${h}: ${v}`, extra: '', headers: { [h]: v } }))),
    ]
    const forced = []
    for (const s of switches) {
      const res = await page.request.get(`/api/assets/search?${param || 'q'}=ap${s.extra}`, { headers: s.headers })
      const body = await res.json().catch(() => null)
      if (res.status() >= 400 || (body && !Array.isArray(body) && body.error)) forced.push(s.label)
    }
    expect.soft(forced, 'a documented switch forces the route to fail').not.toHaveLength(0)
  })
})
