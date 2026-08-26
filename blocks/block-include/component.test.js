import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * OpenProject #954: `_loadNestedBlocks()` resolves a nested block's import URL through
 * `getBlockImportUrl()` (`../shared/config.js`) rather than a hardcoded `/_blocks/${tag}.js`, so a
 * custom block transcluded via `block-include` resolves for readers too, not just authors. Mocked
 * here rather than stubbed via `fetch` (as `../shared/config.test.js` covers `getBlockImportUrl`
 * itself) so this suite can assert on *which* tag the component asked to resolve, independent of
 * that function's own URL-building logic.
 */
vi.mock('../shared/config.js', () => ({
  getBlockImportUrl: vi.fn(async (tag) => `/mock-blocks/${tag}.js`)
}))

import './component.js'
import { getBlockImportUrl } from '../shared/config.js'
import { _resetSiteIdCache } from '../shared/site.js'

const SITE_ID = 'site-1'
const DEFAULT_LOCALES = { primary: 'en', forcePrefix: false, active: ['en'] }

function stubPage(overrides = {}) {
  return {
    title: 'Included Page',
    render: '<p>Included content</p>',
    isLocked: false,
    ...overrides
  }
}

/**
 * Stubs `fetch` for every request `connectedCallback` can make: the site-info lookup `getSiteId()`
 * (and this block itself, for `locales`) reads, and the page-include request. `pageFetchImpl`, when
 * given, replaces the include response entirely -- for a rejection or an error-status response.
 */
function stubFetch({
  locales = DEFAULT_LOCALES,
  page = stubPage(),
  pageOk = true,
  pageStatus = 200,
  pageFetchImpl
} = {}) {
  const fetchMock = vi.fn(async (url) => {
    if (url === '/_api/sites/current') {
      return { ok: true, json: async () => ({ id: SITE_ID, locales }) }
    }
    if (pageFetchImpl) {
      return pageFetchImpl(url)
    }
    return { ok: pageOk, status: pageStatus, json: async () => page }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function includeRequest(fetchMock) {
  const call = fetchMock.mock.calls.find(([url]) => url !== '/_api/sites/current')
  return call?.[0]
}

/**
 * Appends a `<block-include>` and waits for the fetches `connectedCallback` always kicks off.
 * `parent`, if given, is an already-mounted `<block-include>` this one nests inside -- the shape
 * `_ancestorPaths()` climbs to find a cycle. `currentPagePath` stands in for the page this block is
 * actually sitting on -- read back, post-conversion, off `window.location.pathname` rather than a
 * live page store.
 */
async function mountInclude({
  path = 'target-page',
  locale = '',
  showTitle = false,
  parent,
  currentPagePath = 'current-page'
} = {}) {
  history.pushState(null, '', `/${currentPagePath}`)
  const el = document.createElement('block-include')
  // -> `path` as a real HTML attribute, not just a JS property: `_ancestorPaths()` reads a nested
  //    include's OWN `path` off its ancestor elements via `getAttribute`, the same shape the
  //    markdown renderer's `::block-include{path="..."}` actually produces.
  el.setAttribute('path', path)
  el.locale = locale
  el.showTitle = showTitle
  ;(parent ?? document.body).appendChild(el)
  await el.updateComplete
  // -> connectedCallback's fetches are awaited but not blocking connectedCallback itself; each of the
  //    three chained requests (getSiteId, the site-info read, the include read) needs its own turn.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await el.updateComplete
  return el
}

describe('block-include', () => {
  beforeEach(() => {
    _resetSiteIdCache()
  })

  afterEach(() => {
    document.body.replaceChildren()
    delete globalThis.API_CLIENT
    delete globalThis.WIKI_STATE
    vi.unstubAllGlobals()
    history.pushState(null, '', '/')
  })

  it('fetches the requested path/locale with neither globalThis.API_CLIENT nor globalThis.WIKI_STATE defined', async () => {
    expect(globalThis.API_CLIENT).toBeUndefined()
    expect(globalThis.WIKI_STATE).toBeUndefined()

    const fetchMock = stubFetch()
    const el = await mountInclude({ path: 'target-page', locale: 'fr' })

    const url = new URL(includeRequest(fetchMock), 'http://localhost')
    expect(url.pathname).toBe(`/_api/sites/${SITE_ID}/pages/include`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: 'target-page', locale: 'fr' })
    expect(el.textContent).toContain('Included content')
  })

  it("defaults locale to the current page's own locale when none is given", async () => {
    const fetchMock = stubFetch()
    await mountInclude({ path: 'target-page', locale: '' })

    const url = new URL(includeRequest(fetchMock), 'http://localhost')
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: 'target-page', locale: 'en' })
  })

  it('shows the included title only when showTitle is on', async () => {
    stubFetch()
    const withTitle = await mountInclude({ path: 'target-page', showTitle: true })
    const withoutTitle = await mountInclude({ path: 'target-page-2', showTitle: false })

    expect(withTitle.querySelector('h2').textContent).toBe('Included Page')
    expect(withoutTitle.querySelector('h2')).toBeNull()
  })

  /*
    Regression coverage for OpenProject #957: the picker writes `showTitle="false"` into the page
    when an author toggles Show Title on and back off (no `default` meant it compared against `''`
    rather than `false`), and Lit's stock Boolean converter used to read any present attribute —
    `showTitle="false"` included — as true. Reproduced here the way the picker would leave it: the
    attribute literally present with the string "false".
  */
  it('treats the literal attribute showTitle="false" as false', async () => {
    stubFetch()
    const el = document.createElement('block-include')
    el.setAttribute('path', 'target-page')
    el.setAttribute('showtitle', 'false')
    document.body.appendChild(el)
    await el.updateComplete
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await el.updateComplete

    expect(el.showTitle).toBe(false)
    expect(el.querySelector('h2')).toBeNull()
  })

  it('renders into the light DOM, not a shadow root, so the article stylesheet reaches it', async () => {
    stubFetch()
    const el = await mountInclude()
    expect(el.shadowRoot).toBeNull()
  })

  it('refuses a page naming itself, before any request goes out', async () => {
    const fetchMock = stubFetch()
    const el = await mountInclude({ path: 'same-page', currentPagePath: 'same-page' })

    expect(el.textContent).toContain('This page includes itself')
    expect(includeRequest(fetchMock)).toBeUndefined()
  })

  it('refuses a cycle through a currently-open ancestor include, case/slash-insensitively', async () => {
    const fetchMock = stubFetch()
    const outer = await mountInclude({ path: '/Ancestor-Page/' })
    // -> The nested include is appended as a child of the outer one's rendered content
    const inner = await mountInclude({ path: 'ancestor-page', parent: outer })

    expect(inner.textContent).toContain('would loop')
    expect(fetchMock.mock.calls.filter(([url]) => url !== '/_api/sites/current')).toHaveLength(1) // only the outer include fetched
  })

  it('refuses nesting deeper than MAX_DEPTH (3)', async () => {
    stubFetch()
    history.pushState(null, '', '/root')
    let current = document.body
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('block-include')
      el.setAttribute('path', `level-${i}`)
      current.appendChild(el)
      await el.updateComplete
      await new Promise((resolve) => setTimeout(resolve, 0))
      current = el
    }
    // -> A 4th level: root page + 3 already-open includes = chain length 4, over MAX_DEPTH (3)
    const tooDeep = document.createElement('block-include')
    tooDeep.setAttribute('path', 'level-3')
    current.appendChild(tooDeep)
    await tooDeep.updateComplete
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tooDeep.textContent).toContain('nested more than 3 pages deep')
  })

  it('shows a not-found message for a 404 response', async () => {
    stubFetch({ pageFetchImpl: () => ({ ok: false, status: 404, json: async () => null }) })
    const el = await mountInclude({ path: 'missing-page' })

    expect(el.textContent).toContain('There is no page at "missing-page"')
  })

  it('shows a generic failure message for a non-404 error', async () => {
    stubFetch({
      pageFetchImpl: () => {
        throw new Error('network down')
      }
    })
    const el = await mountInclude({ path: 'broken-page' })

    expect(el.textContent).toContain('could not be included')
  })

  /*
   * OpenProject #954: before this fix, `_loadNestedBlocks()` always fetched `/_blocks/${tag}.js`,
   * which 404s for a custom block -- it has no such flat file, only a per-site
   * `/_blocks/custom/:siteId/:id.js` route. This mounts a transcluded page whose content brings an
   * undefined `<block-widget>` element with it and asserts the component resolves that tag through
   * `getBlockImportUrl()` instead of guessing a URL itself.
   */
  it("resolves a nested block's import URL through getBlockImportUrl(), not a hardcoded flat path", async () => {
    stubFetch({
      page: stubPage({ render: '<p>Text</p><block-widget></block-widget>' })
    })

    await mountInclude({ path: 'page-with-nested-block' })
    // -> `_loadNestedBlocks()`'s own `import()` attempt needs a further turn past `mountInclude`'s
    //    own waits to settle (it rejects, since nothing is actually served at the mocked URL)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getBlockImportUrl).toHaveBeenCalledWith('block-widget')
  })

  it('points at the unlock prompt rather than asking for a password itself, for a locked page', async () => {
    stubFetch({ page: stubPage({ isLocked: true }) })
    const el = await mountInclude({ path: 'locked-page' })

    expect(el.textContent).toContain('password protected')
    expect(el.textContent).toContain('Open it to enter the password')
  })
})
