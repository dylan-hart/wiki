import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BlockIndexElement } from './component.js'
import { _resetSiteCache } from '../shared/site.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom, stubSiteFetch, TEST_SITE_ID as SITE_ID } from '../test/mount.js'

/** Per the WCAG formula, which is where the constants below come from. */
function relativeLuminance(hex) {
  const channel = (value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexA)
  const lB = relativeLuminance(hexB)
  const [lighter, darker] = lA >= lB ? [lA, lB] : [lB, lA]
  return (lighter + 0.05) / (darker + 0.05)
}

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
 * Both hops: the site lookup and the tree listing. The current page's locale is read off the
 * address bar, so a test wanting a non-primary reader sets `pathname` to that reader's URL.
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

function treeCall(fetchMock) {
  const [url] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
  return new URL(url, 'http://localhost')
}

/** `settle: 1`: two fetch hops deep (site -> tree), and one macrotask turn drains both. */
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

  it("reads a locale URL alias off the address bar as the reader's locale and links under it", async () => {
    const fetchMock = stubFetch({
      locales: {
        primary: 'en',
        active: ['en', 'zh-CN'],
        forcePrefix: false,
        aliases: { 'zh-CN': 'zh' }
      },
      pathname: '/zh/some/page'
    })
    const el = await mountIndex()

    expect(treeCall(fetchMock).searchParams.get('locale')).toBe('zh-CN')
    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/zh/docs/intro')
  })

  it('prefixes even the primary locale when forcePrefix is on', async () => {
    stubFetch({ locales: { primary: 'en', active: ['en', 'fr'], forcePrefix: true } })
    const el = await mountIndex()

    expect(el.shadowRoot.querySelector('li a').getAttribute('href')).toBe('/en/docs/intro')
  })

  it('does not fetch icons when showIcons is off', async () => {
    const fetchMock = stubFetch()
    await mountIndex({ showIcons: false })
    // -> The site lookup and the tree request; an icon fetch would be a third
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  /*
    Asserted off which icon was requested rather than off rendered SVG: `stubFetch` answers every
    hop with the same page-list JSON, which `fetchIcon` treats as "no icon", leaving the request
    itself as the one observable signal. `settle: 2` for the third hop, `_loadIcons()`'s fetches.
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
    expect(requestedUrls).toContain('/_icons/tabler/book-2.svg')
    expect(requestedUrls).toContain('/_icons/tabler/file-text.svg')
  })

  it("does not let hasChildren override a page's own chosen icon (OpenProject #2462)", async () => {
    const fetchMock = stubFetch({
      pages: [
        stubPage({ path: 'docs/guide', title: 'Guide', icon: 'tabler:star', hasChildren: true })
      ]
    })

    await mountBlock('block-index', { props: { showIcons: true }, settle: 2 })

    const requestedUrls = fetchMock.mock.calls.map(([url]) => url)
    expect(requestedUrls).toContain('/_icons/tabler/star.svg')
    expect(requestedUrls).not.toContain('/_icons/tabler/book-2.svg')
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
    // -> Without the stub there is no site to resolve, and so no row to click at all
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
   * The description text's dark-mode color lives in the shared `--block-*`/`--index-*`
   * custom-property layer (`frontend/src/css/tailwind.css`), not in this component's source, so the
   * WCAG AA 4.5:1 floor for body text is checked there, against the row's real dark background.
   */
  describe('dark-mode text contrast (OpenProject #2501, #2875)', () => {
    const componentSource = readFileSync(path.join(import.meta.dirname, 'component.js'), 'utf8')
    const tokenSource = readFileSync(
      path.join(import.meta.dirname, '../../frontend/src/css/tailwind.css'),
      'utf8'
    )

    it('reads .text span color off --index-description-fg', () => {
      expect(componentSource).toMatch(/\.text span\s*{[^}]*color:\s*var\(--index-description-fg\)/)
    })

    it('gives --index-description-fg a Ledger-dark value meeting 4.5:1 against --block-bg', () => {
      // -> `body.body--dark { … }` appears more than once in tailwind.css; merge every one rather
      //    than assume which block holds this property.
      const darkBlocks = [...tokenSource.matchAll(/body\.body--dark\s*{([^}]*)}/g)]
      expect(darkBlocks.length).toBeGreaterThan(0)
      const merged = darkBlocks.map((m) => m[1]).join('\n')
      const descriptionFg = merged.match(/--index-description-fg:\s*(#[0-9a-fA-F]{6});/)
      expect(descriptionFg).not.toBeNull()

      // -> #1b1f2a is --block-bg under body.body--dark (var(--color-dark-3)), the row's real
      //    dark-mode background
      expect(contrastRatio(descriptionFg[1], '#1b1f2a')).toBeGreaterThanOrEqual(4.5)
    })

    it('still fails the pre-#2875 light-mode #666 against that background (proves the token is load-bearing)', () => {
      expect(contrastRatio('#666666', '#1b1f2a')).toBeLessThan(4.5)
    })
  })

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

  // -> The block picker and Admin > Blocks render this text verbatim, and it is the only place an
  //    author hunting for a nested table of contents would recognize the block from.
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
