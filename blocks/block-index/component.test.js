import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BlockIndexElement } from './component.js'
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

  // -> OpenProject #2463 (docs/discoverability pass): the block picker and Admin > Blocks both
  //    render this text verbatim as the only way an author learns what the block is for, so a
  //    reader looking for a "book/chapter" or nested table-of-contents feature needs to recognize
  //    it from here -- this guards the wording that fixes that against a silent regression back to
  //    the old, use-case-free "Displays a list of pages contained in a folder."
  describe('discoverability (OpenProject #2463)', () => {
    it("describes the nested/book-chapter use case in the block's own metadata", () => {
      expect(BlockIndexElement.definition.description).toMatch(/book\/chapter/i)
      expect(BlockIndexElement.definition.description).toMatch(/table of contents/i)
    })

    it('explains what raising Depth above 0 does for the depth prop', () => {
      const depthProp = BlockIndexElement.definition.props.find((prop) => prop.name === 'depth')
      expect(depthProp.hint).toMatch(/subfolders/i)
      expect(depthProp.hint).toMatch(/book\/chapter/i)
    })
  })
})
