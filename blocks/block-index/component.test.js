import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'

function stubPage(overrides = {}) {
  return {
    path: 'docs/intro',
    title: 'Intro',
    description: '',
    icon: '',
    ...overrides
  }
}

/** Appends a `<block-index>` and waits for the fetch `connectedCallback` always kicks off. */
async function mountIndex(attrs = {}) {
  const el = document.createElement('block-index')
  for (const [key, value] of Object.entries(attrs)) {
    el[key] = value
  }
  document.body.appendChild(el)
  await el.updateComplete
  await new Promise((resolve) => queueMicrotask(resolve))
  await el.updateComplete
  return el
}

describe('block-index', () => {
  beforeEach(() => {
    globalThis.WIKI_STATE = {
      site: { id: 'site-1', locales: { primary: 'en', forcePrefix: false, active: [{}] } },
      page: { locale: 'en' }
    }
    globalThis.API_CLIENT = {
      get: vi.fn(() => ({ json: () => Promise.resolve([stubPage()]) }))
    }
    globalThis.WIKI_ROUTER = { push: vi.fn() }
  })

  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
    delete globalThis.WIKI_STATE
    delete globalThis.API_CLIENT
    delete globalThis.WIKI_ROUTER
  })

  it('fetches the tree with the given query props and renders a row per page', async () => {
    const el = await mountIndex({ path: 'docs', tags: 'guide', limit: 5, depth: 1 })

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/tree/pages', {
      searchParams: {
        locale: 'en',
        path: 'docs',
        limit: 5,
        orderBy: 'title',
        orderByDirection: 'asc',
        depth: 1,
        tags: 'guide'
      }
    })
    const rows = el.shadowRoot.querySelectorAll('li a')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Intro')
  })

  it('shows noResultMsg when the query matches no pages', async () => {
    globalThis.API_CLIENT.get = vi.fn(() => ({ json: () => Promise.resolve([]) }))
    const el = await mountIndex({ noResultMsg: 'Nothing here.' })

    expect(el.shadowRoot.querySelector('.no-links').textContent.trim()).toBe('Nothing here.')
    expect(el.shadowRoot.querySelector('li')).toBeNull()
  })

  it('leaves hrefs unprefixed when the page is already on the primary locale', async () => {
    const el = await mountIndex()
    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/docs/intro')
  })

  it("prefixes hrefs with the reader's locale when it is not the primary one", async () => {
    globalThis.WIKI_STATE.page.locale = 'fr'
    globalThis.WIKI_STATE.site.locales.active = [{}, {}] // -> more than one active locale
    const el = await mountIndex()

    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/fr/docs/intro')
  })

  it('prefixes even the primary locale when forcePrefix is on', async () => {
    globalThis.WIKI_STATE.site.locales.forcePrefix = true
    globalThis.WIKI_STATE.site.locales.active = [{}, {}]
    const el = await mountIndex()

    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/en/docs/intro')
  })

  it('does not fetch icons when showIcons is off', async () => {
    await mountIndex({ showIcons: false })
    // -> Only the tree request; fetchIcon would hit /_icons via fetch, unmocked here, so a call
    //    fetching an icon would surface as a real network error rather than passing silently
    expect(globalThis.API_CLIENT.get).toHaveBeenCalledTimes(1)
  })

  it("navigates through WIKI_ROUTER instead of a full page load on a row's click", async () => {
    const el = await mountIndex()
    const anchor = el.shadowRoot.querySelector('li a')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })

    anchor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(globalThis.WIKI_ROUTER.push).toHaveBeenCalledWith('/docs/intro')
  })

  it('leaves a ctrl-click alone so the browser can open a new tab', async () => {
    const el = await mountIndex()
    const anchor = el.shadowRoot.querySelector('li a')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })

    anchor.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(globalThis.WIKI_ROUTER.push).not.toHaveBeenCalled()
  })

  it('degrades to a plain link without throwing when WIKI_ROUTER is missing', async () => {
    delete globalThis.WIKI_ROUTER
    const el = await mountIndex()
    const anchor = el.shadowRoot.querySelector('li a')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })

    expect(() => anchor.dispatchEvent(event)).not.toThrow()
    expect(event.defaultPrevented).toBe(false)
  })

  it('logs and keeps _loading false rather than throwing when the fetch fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    globalThis.API_CLIENT.get = vi.fn(() => ({ json: () => Promise.reject(new Error('boom')) }))

    const el = await mountIndex()

    expect(warnSpy).toHaveBeenCalled()
    expect(el.shadowRoot.querySelector('.no-links')).not.toBeNull()
    warnSpy.mockRestore()
  })

  describe('dark mode', () => {
    it('follows body--dark via the shared DarkMode controller', async () => {
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
