import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { _resetSiteIdCache } from '../shared/site.js'

const SITE_ID = 'site-1'

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
  const fetchMock = vi.fn(async (url) => {
    if (url === '/_api/sites/current') {
      return { ok: true, json: async () => ({ id: SITE_ID, locales }) }
    }
    return { ok: true, json: async () => pages }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The one non-site-lookup call this suite's assertions care about. */
function treeCall(fetchMock) {
  const [url] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
  return new URL(url, 'http://localhost')
}

/** Appends a `<block-index>` and waits for the fetch chain `connectedCallback` always kicks off. */
async function mountIndex(attrs = {}) {
  const el = document.createElement('block-index')
  for (const [key, value] of Object.entries(attrs)) {
    el[key] = value
  }
  document.body.appendChild(el)
  await el.updateComplete
  // -> Now two fetch hops deep (site -> tree); `setTimeout(0)` drains every microtask queued by
  //    either, the same pattern `block-live-data`'s own test uses for its `getSiteId` fetch.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await el.updateComplete
  return el
}

describe('block-index', () => {
  beforeEach(() => {
    _resetSiteIdCache()
    globalThis.WIKI_ROUTER = { push: vi.fn() }
  })

  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
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

  it('logs and keeps _loading false rather than throwing when the fetch fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        url === '/_api/sites/current'
          ? { ok: true, json: async () => ({ id: SITE_ID, locales: { primary: 'en' } }) }
          : { ok: false, status: 500 }
      )
    )

    const el = await mountIndex()

    expect(warnSpy).toHaveBeenCalled()
    expect(el.shadowRoot.querySelector('.no-links')).not.toBeNull()
    warnSpy.mockRestore()
  })

  describe('dark mode', () => {
    it('follows body--dark via the shared DarkMode controller', async () => {
      stubFetch()
      document.body.classList.add('body--dark')
      const el = await mountIndex()

      expect(el.hasAttribute('dark')).toBe(true)

      document.body.classList.remove('body--dark')
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      expect(el.hasAttribute('dark')).toBe(false)
    })
  })
})
