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
 * Stubs `fetch` for both requests `connectedCallback` makes: the site-info lookup `getSiteId()` (and
 * this block itself, for `locales`) reads, and the tree-of-pages request.
 */
function stubFetch({ locales, pages = [stubPage()] } = {}) {
  const fetchMock = vi.fn(async (url) => {
    if (url === '/_api/sites/current') {
      return { ok: true, json: async () => ({ id: SITE_ID, locales }) }
    }
    return { ok: true, json: async () => pages }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Appends a `<block-index>` and waits for the fetches `connectedCallback` always kicks off. */
async function mountIndex(attrs = {}) {
  const el = document.createElement('block-index')
  for (const [key, value] of Object.entries(attrs)) {
    el[key] = value
  }
  document.body.appendChild(el)
  await el.updateComplete
  // -> Two chained fetches (getSiteId, then the site-info read, then the tree read) each need their
  //    own microtask turn to settle.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await el.updateComplete
  return el
}

function treeRequest(fetchMock) {
  const call = fetchMock.mock.calls.find(([url]) => url !== '/_api/sites/current')
  return call?.[0]
}

describe('block-index', () => {
  beforeEach(() => {
    _resetSiteIdCache()
    history.pushState(null, '', '/')
  })

  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
    vi.unstubAllGlobals()
    history.pushState(null, '', '/')
  })

  it('fetches the tree with neither globalThis.API_CLIENT nor globalThis.WIKI_STATE defined', async () => {
    expect(globalThis.API_CLIENT).toBeUndefined()
    expect(globalThis.WIKI_STATE).toBeUndefined()

    const fetchMock = stubFetch({ locales: { primary: 'en', forcePrefix: false, active: ['en'] } })
    await mountIndex({ path: 'docs', tags: 'guide', limit: 5, depth: 1 })

    const url = new URL(treeRequest(fetchMock), 'http://localhost')
    expect(url.pathname).toBe(`/_api/sites/${SITE_ID}/tree/pages`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: 'docs',
      limit: '5',
      orderBy: 'title',
      orderByDirection: 'asc',
      depth: '1',
      locale: 'en',
      tags: 'guide'
    })
  })

  it('renders a row per page returned by the tree fetch', async () => {
    stubFetch({ locales: { primary: 'en', forcePrefix: false, active: ['en'] } })
    const el = await mountIndex()

    const rows = el.shadowRoot.querySelectorAll('li a')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Intro')
  })

  it('shows noResultMsg when the query matches no pages', async () => {
    stubFetch({ locales: { primary: 'en', forcePrefix: false, active: ['en'] }, pages: [] })
    const el = await mountIndex({ noResultMsg: 'Nothing here.' })

    expect(el.shadowRoot.querySelector('.no-links').textContent.trim()).toBe('Nothing here.')
    expect(el.shadowRoot.querySelector('li')).toBeNull()
  })

  it('leaves hrefs unprefixed when the page is already on the primary locale', async () => {
    stubFetch({ locales: { primary: 'en', forcePrefix: false, active: ['en'] } })
    const el = await mountIndex()
    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/docs/intro')
  })

  it("prefixes hrefs with the reader's locale when it is not the primary one", async () => {
    history.pushState(null, '', '/fr/some/page')
    stubFetch({ locales: { primary: 'en', forcePrefix: false, active: ['en', 'fr'] } })
    const el = await mountIndex()

    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/fr/docs/intro')
  })

  it('prefixes even the primary locale when forcePrefix is on', async () => {
    stubFetch({ locales: { primary: 'en', forcePrefix: true, active: ['en', 'fr'] } })
    const el = await mountIndex()

    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/en/docs/intro')
  })

  it('does not fetch icons when showIcons is off', async () => {
    const fetchMock = stubFetch({ locales: { primary: 'en', forcePrefix: false, active: ['en'] } })
    await mountIndex({ showIcons: false })
    // -> getSiteId()'s own site-info read, this block's own site-info read (for `locales`), and the
    //    tree request -- three calls, none of them an icon fetch. fetchIcon would hit /_icons via
    //    fetch, unmocked here, so a call fetching an icon would surface as a real network error
    //    rather than passing silently.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("navigates through WIKI_ROUTER instead of a full page load on a row's click", async () => {
    globalThis.WIKI_ROUTER = { push: vi.fn() }
    stubFetch({ locales: { primary: 'en', forcePrefix: false, active: ['en'] } })
    const el = await mountIndex()
    const anchor = el.shadowRoot.querySelector('li a')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })

    anchor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(globalThis.WIKI_ROUTER.push).toHaveBeenCalledWith('/docs/intro')
    delete globalThis.WIKI_ROUTER
  })

  it('logs and keeps _loading false rather than throwing when the tree fetch fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (url === '/_api/sites/current') {
          return { ok: true, json: async () => ({ id: SITE_ID }) }
        }
        throw new Error('boom')
      })
    )

    const el = await mountIndex()

    expect(warnSpy).toHaveBeenCalled()
    expect(el.shadowRoot.querySelector('.no-links')).not.toBeNull()
    warnSpy.mockRestore()
  })

  it('logs and keeps _loading false rather than throwing when the site cannot be resolved', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => null }))
    )

    const el = await mountIndex()

    expect(warnSpy).toHaveBeenCalled()
    expect(el.shadowRoot.querySelector('.no-links')).not.toBeNull()
    warnSpy.mockRestore()
  })

  describe('dark mode', () => {
    it('follows body--dark via the shared DarkMode controller', async () => {
      stubFetch({ locales: { primary: 'en', forcePrefix: false, active: ['en'] } })
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
