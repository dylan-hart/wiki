import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { _resetSiteCache } from '../shared/site.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom, stubSiteFetch, TEST_SITE_ID as SITE_ID } from '../test/mount.js'

function stubPage(overrides = {}) {
  return {
    path: 'docs/intro',
    title: 'Intro',
    description: '',
    icon: '',
    ...overrides
  }
}

/**
 * Stubs `fetch` for both hops `connectedCallback` now makes instead of `API_CLIENT`/`WIKI_STATE`:
 * the site lookup (`../shared/site.js`'s `getSiteId`/`getSiteLocales`/`getCurrentPage`) and the tree
 * listing itself. `pathname` stands in for `WIKI_STATE.page.locale` -- the current page's locale is
 * now read off the browser's own address bar, so a test that wants a non-primary reader sets the URL
 * a reader on that locale would actually be at.
 */
function stubFetch({
  locales = { primary: 'en', active: ['en'], forcePrefix: false },
  pages = [stubPage()],
  pathname = '/some/page'
} = {}) {
  window.history.pushState({}, '', pathname)
  return stubSiteFetch({
    site: { locales },
    onRequest: async () => ({ ok: true, json: async () => pages })
  })
}

/** The one non-site-lookup call this suite's assertions care about. */
function treeCall(fetchMock) {
  const [url] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
  return new URL(url, 'http://localhost')
}

/**
 * Appends a `<block-index>` and waits for the fetch chain `connectedCallback` always kicks off.
 *
 * `settle: 1`: two fetch hops deep (site -> tree), and one macrotask turn drains every microtask
 * queued by either.
 */
const mountIndex = (props = {}) => mountBlock('block-index', { props, settle: 1 })

describe('block-index', () => {
  beforeEach(() => {
    _resetSiteCache()
    globalThis.WIKI_ROUTER = { push: vi.fn() }
  })

  afterEach(() => {
    resetBlockDom()
    delete globalThis.WIKI_ROUTER
    vi.unstubAllGlobals()
    window.history.pushState({}, '', '/')
  })

  it('fetches the tree with the given query props and renders a row per page', async () => {
    const fetchMock = stubFetch()
    const el = await mountIndex({ path: 'docs', tags: 'guide', limit: 5, depth: 1 })

    const call = treeCall(fetchMock)
    expect(call.pathname).toBe(`/_api/sites/${SITE_ID}/tree/pages`)
    expect(Object.fromEntries(call.searchParams)).toEqual({
      locale: 'en',
      path: 'docs',
      limit: '5',
      orderBy: 'title',
      orderByDirection: 'asc',
      depth: '1',
      tags: 'guide'
    })
    const rows = el.shadowRoot.querySelectorAll('li a')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Intro')
  })

  it('shows noResultMsg when the query matches no pages', async () => {
    stubFetch({ pages: [] })
    const el = await mountIndex({ noResultMsg: 'Nothing here.' })

    expect(el.shadowRoot.querySelector('.no-links').textContent.trim()).toBe('Nothing here.')
    expect(el.shadowRoot.querySelector('li')).toBeNull()
  })

  it('leaves hrefs unprefixed when the page is already on the primary locale', async () => {
    stubFetch()
    const el = await mountIndex()
    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/docs/intro')
  })

  it("prefixes hrefs with the reader's locale when it is not the primary one", async () => {
    stubFetch({
      locales: { primary: 'en', active: ['en', 'fr'], forcePrefix: false },
      pathname: '/fr/some/page'
    })
    const el = await mountIndex()

    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/fr/docs/intro')
  })

  it('prefixes even the primary locale when forcePrefix is on', async () => {
    stubFetch({ locales: { primary: 'en', active: ['en', 'fr'], forcePrefix: true } })
    const el = await mountIndex()

    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/en/docs/intro')
  })

  it('does not fetch icons when showIcons is off', async () => {
    const fetchMock = stubFetch()
    await mountIndex({ showIcons: false })
    // -> Only the site lookup and the tree request; fetchIcon would hit /_icons via fetch,
    //    unmocked here, so a call fetching an icon would surface as a real network error rather
    //    than passing silently
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  /*
    OpenProject #2462: a "book" page -- one with a page nested below its own path -- draws a
    different default icon than a leaf "file" page, driven by the `hasChildren` signal
    `GET tree/pages` now carries. Asserted off which icon reference was fetched rather than off
    rendered SVG content, since `stubFetch`'s `onRequest` answers every hop with the same page-list
    JSON body -- `fetchIcon`'s `resp.text()` on that body rejects and resolves to `''`, which
    `fetchIcon` already treats as "no icon" (see its own doc comment), leaving the request itself as
    the one observable signal.

    `settle: 2`: connectedCallback is a third hop deeper than the two `mountIndex` (settle: 1)
    covers elsewhere in this file -- site lookup, then the tree fetch, then `_loadIcons()`'s icon
    fetches once `showIcons` is on.
  */
  it('requests the book icon for a page with children and the file icon for a leaf (OpenProject #2462)', async () => {
    const fetchMock = stubFetch({
      pages: [
        stubPage({ path: 'docs/guide', title: 'Guide', hasChildren: true }),
        stubPage({ path: 'docs/leaf', title: 'Leaf', hasChildren: false })
      ]
    })

    await mountBlock('block-index', { props: { showIcons: true }, settle: 2 })

    const requestedUrls = fetchMock.mock.calls.map(([url]) => url)
    expect(requestedUrls).toContain('/_icons/mdi/book-open-page-variant-outline.svg')
    expect(requestedUrls).toContain('/_icons/mdi/file-document-outline.svg')
  })

  it("does not let hasChildren override a page's own chosen icon (OpenProject #2462)", async () => {
    const fetchMock = stubFetch({
      pages: [stubPage({ path: 'docs/guide', title: 'Guide', icon: 'mdi:star', hasChildren: true })]
    })

    await mountBlock('block-index', { props: { showIcons: true }, settle: 2 })

    const requestedUrls = fetchMock.mock.calls.map(([url]) => url)
    expect(requestedUrls).toContain('/_icons/mdi/star.svg')
    expect(requestedUrls).not.toContain('/_icons/mdi/book-open-page-variant-outline.svg')
  })

  it("navigates through WIKI_ROUTER instead of a full page load on a row's click", async () => {
    stubFetch()
    const el = await mountIndex()
    const anchor = el.shadowRoot.querySelector('li a')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })

    anchor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(globalThis.WIKI_ROUTER.push).toHaveBeenCalledWith('/docs/intro')
  })

  it('leaves a ctrl-click alone so the browser can open a new tab', async () => {
    // -> Without the stub there is no site to resolve, so the block renders its "could not
    //    determine the current site" state and there is no row to click at all.
    stubFetch()
    const el = await mountIndex()
    const anchor = el.shadowRoot.querySelector('li a')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })

    anchor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(globalThis.WIKI_ROUTER.push).not.toHaveBeenCalled()
  })

  it('degrades to a plain link without throwing when WIKI_ROUTER is missing', async () => {
    delete globalThis.WIKI_ROUTER
    stubFetch()
    const el = await mountIndex()
    const anchor = el.shadowRoot.querySelector('li a')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })

    expect(() => anchor.dispatchEvent(event)).not.toThrow()
    expect(event.defaultPrevented).toBe(false)
  })

  it('logs and keeps _loading false rather than throwing when the fetch fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubSiteFetch({
      site: { locales: { primary: 'en' } },
      onRequest: async () => ({ ok: false, status: 500 })
    })

    const el = await mountIndex()

    expect(warnSpy).toHaveBeenCalled()
    expect(el.shadowRoot.querySelector('.no-links')).not.toBeNull()
    warnSpy.mockRestore()
  })

  describeDarkMode(() => {
    stubFetch()
    return mountIndex()
  })

  /**
   * OpenProject #2461: `block-index` used to render a flat list regardless of a page's `depth`. Each
   * row's `--depth` custom property is what now draws it nested/indented, and a listing carrying any
   * depth > 0 forces a single column so the indent reads against the right width.
   */
  describe('nested/indented rendering (OpenProject #2461)', () => {
    it('draws every row flush (depth 0) when every page has no depth', async () => {
      stubFetch({ pages: [stubPage({ path: 'docs/a', title: 'A', depth: 0 })] })
      const el = await mountIndex()

      const row = el.shadowRoot.querySelector('li')
      expect(row.style.getPropertyValue('--depth')).toBe('0')
    })

    it("indents each row by its own page's depth, independent of its siblings", async () => {
      stubFetch({
        pages: [
          stubPage({ path: 'docs/parent', title: 'Parent', depth: 0 }),
          stubPage({ path: 'docs/parent/child', title: 'Child', depth: 1 }),
          stubPage({ path: 'docs/parent/child/grand', title: 'Grandchild', depth: 2 })
        ]
      })
      const el = await mountIndex({ depth: 2 })

      const rows = [...el.shadowRoot.querySelectorAll('li')]
      expect(rows.map((row) => row.style.getPropertyValue('--depth'))).toEqual(['0', '1', '2'])
    })

    it('treats a missing depth (e.g. an older API response) as 0 rather than throwing', async () => {
      stubFetch({ pages: [stubPage({ path: 'docs/a', title: 'A' })] })
      const el = await mountIndex()

      expect(el.shadowRoot.querySelector('li').style.getPropertyValue('--depth')).toBe('0')
    })

    it('lays out the normal multi-column grid when nothing is nested', async () => {
      stubFetch({
        pages: [
          stubPage({ path: 'docs/a', title: 'A', depth: 0 }),
          stubPage({ path: 'docs/b', title: 'B', depth: 0 })
        ]
      })
      const el = await mountIndex({ columns: '2' })

      expect(el.shadowRoot.querySelector('ul').getAttribute('style')).toBeFalsy()
    })

    it('forces a single column once any row is nested, so the indent is not squeezed by a second column', async () => {
      stubFetch({
        pages: [
          stubPage({ path: 'docs/a', title: 'A', depth: 0 }),
          stubPage({ path: 'docs/a/b', title: 'B', depth: 1 })
        ]
      })
      const el = await mountIndex({ columns: '2' })

      expect(el.shadowRoot.querySelector('ul').style.gridTemplateColumns).toBe(
        'repeat(1, minmax(0, 1fr))'
      )
    })
  })
})
