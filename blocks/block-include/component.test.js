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

/*
 * OpenProject #1638: the not-found/include-failed messages resolve through `../shared/i18n.js`'s
 * `t()`, which has its own dedicated coverage (`shared/i18n.test.js` -- resolution, English fallback,
 * fetch failure, param interpolation). Mocked here the same way `../shared/config.js` is mocked
 * above, and for the identical reason: this suite is about `connectedCallback`'s own branching, not
 * about re-proving `t()` resolves correctly, and a real `t()` would mean this suite's `_error` state
 * only lands after an actual (failing, since nothing is listening) network round trip -- unlike every
 * other awaited step here, which is a mocked `fetch` promise resolving within a microtask.
 * `vi.hoisted` so `i18nT` is assignable outside the (hoisted) `vi.mock` factory -- later tests assert
 * on its calls and override its resolved value directly.
 */
const i18nT = vi.hoisted(() => vi.fn(async (_key, fallback) => fallback))
vi.mock('../shared/i18n.js', () => ({ t: i18nT }))

import './component.js'
import { getBlockImportUrl } from '../shared/config.js'
import { _resetSiteCache } from '../shared/site.js'
import { mountBlock, resetBlockDom, stubSiteFetch, TEST_SITE_ID as SITE_ID } from '../test/mount.js'

function stubPage(overrides = {}) {
  return {
    title: 'Included Page',
    render: '<p>Included content</p>',
    isLocked: false,
    ...overrides
  }
}

/**
 * Stubs `fetch` for both hops this block now makes instead of `WIKI_STATE`/`API_CLIENT`: the site
 * lookup (`../shared/site.js`'s `getSiteId`/`getCurrentPage`) and the include route itself.
 * `pathname` stands in for `WIKI_STATE.page.path`/`.locale` -- both are now read off the browser's
 * own address bar rather than a page store this block cannot reach.
 */
function stubFetch({
  page = stubPage(),
  pathname = '/current-page',
  locales = { primary: 'en', active: ['en'] },
  includeResult = 'success' // 'success' | 'notFound' | 'networkError'
} = {}) {
  window.history.pushState({}, '', pathname)
  return stubSiteFetch({
    site: { locales },
    onRequest: async () => {
      if (includeResult === 'notFound') {
        return { ok: false, status: 404, json: async () => null }
      }
      if (includeResult === 'networkError') {
        throw new Error('network down')
      }
      return { ok: true, status: 200, json: async () => page }
    }
  })
}

/** Just the calls to the include route itself, excluding the shared site lookup underneath. */
function includeCalls(fetchMock) {
  return fetchMock.mock.calls.filter(([url]) => url.includes('/pages/include'))
}

/**
 * Appends a `<block-include>` and waits for the fetch chain `connectedCallback` always kicks off.
 * `parent`, if given, is an already-mounted `<block-include>` this one nests inside -- the shape
 * `_ancestorPaths()` climbs to find a cycle.
 */
const mountInclude = ({ path = 'target-page', locale = '', showTitle = false, parent } = {}) =>
  mountBlock('block-include', {
    // -> `path` as a real HTML attribute, not just a JS property: `_ancestorPaths()` reads a nested
    //    include's OWN `path` off its ancestor elements via `getAttribute`, the same shape the
    //    markdown renderer's `::block-include{path="..."}` actually produces.
    attrs: { path },
    props: { locale, showTitle },
    parent,
    // -> `settle: 1`: two fetch hops deep (site -> include), and one macrotask turn drains every
    //    microtask queued by either.
    settle: 1
  })

describe('block-include', () => {
  beforeEach(() => {
    _resetSiteCache()
    stubFetch()
  })

  afterEach(() => {
    resetBlockDom()
    vi.unstubAllGlobals()
    window.history.pushState({}, '', '/')
    i18nT.mockClear()
  })

  it('fetches the requested path/locale and renders the included page', async () => {
    const fetchMock = stubFetch({ pathname: '/current-page' })
    const el = await mountInclude({ path: 'target-page', locale: 'fr' })

    const [call] = includeCalls(fetchMock)
    const url = new URL(call[0], 'http://localhost')
    expect(url.pathname).toBe(`/_api/sites/${SITE_ID}/pages/include`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: 'target-page', locale: 'fr' })
    expect(el.textContent).toContain('Included content')
  })

  it("defaults locale to the current page's own locale when none is given", async () => {
    const fetchMock = stubFetch({
      pathname: '/current-page',
      locales: { primary: 'en', active: ['en'] }
    })
    await mountInclude({ path: 'target-page', locale: '' })

    const [call] = includeCalls(fetchMock)
    const searchParams = new URL(call[0], 'http://localhost').searchParams
    expect(Object.fromEntries(searchParams)).toEqual({ path: 'target-page', locale: 'en' })
  })

  it('shows the included title only when showTitle is on', async () => {
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
    const el = await mountBlock('block-include', {
      attrs: { path: 'target-page', showtitle: 'false' },
      settle: 1
    })

    expect(el.showTitle).toBe(false)
    expect(el.querySelector('h2')).toBeNull()
  })

  it('renders into the light DOM, not a shadow root, so the article stylesheet reaches it', async () => {
    const el = await mountInclude()
    expect(el.shadowRoot).toBeNull()
  })

  it('refuses a page naming itself, before any page request goes out', async () => {
    const fetchMock = stubFetch({ pathname: '/same-page' })
    const el = await mountInclude({ path: 'same-page' })

    expect(el.textContent).toContain('This page includes itself')
    expect(includeCalls(fetchMock)).toHaveLength(0)
  })

  it('refuses a cycle through a currently-open ancestor include, case/slash-insensitively', async () => {
    const fetchMock = stubFetch()
    const outer = await mountInclude({ path: '/Ancestor-Page/' })
    // -> The nested include is appended as a child of the outer one's rendered content
    const inner = await mountInclude({ path: 'ancestor-page', parent: outer })

    expect(inner.textContent).toContain('would loop')
    expect(includeCalls(fetchMock)).toHaveLength(1) // only the outer include fetched
  })

  it('refuses nesting deeper than MAX_DEPTH (3)', async () => {
    stubFetch({ pathname: '/root' })
    let current = document.body
    for (let i = 0; i < 3; i++) {
      current = await mountInclude({ path: `level-${i}`, parent: current })
    }
    // -> A 4th level: root page + 3 already-open includes = chain length 4, over MAX_DEPTH (3)
    const tooDeep = await mountInclude({ path: 'level-3', parent: current })

    expect(tooDeep.textContent).toContain('nested more than 3 pages deep')
  })

  it('shows a not-found message for a 404 response', async () => {
    stubFetch({ includeResult: 'notFound' })
    const el = await mountInclude({ path: 'missing-page' })

    expect(el.textContent).toContain('There is no page at "missing-page"')
  })

  it('shows a generic failure message for a non-404 error', async () => {
    stubFetch({ includeResult: 'networkError' })
    const el = await mountInclude({ path: 'broken-page' })

    expect(el.textContent).toContain('could not be included')
  })

  describe('the not-found/include-failed messages resolve through the shared i18n resolver, not a literal', () => {
    it('asks the resolver for the not-found key, with the path as an interpolation param', async () => {
      stubFetch({ includeResult: 'notFound' })
      await mountInclude({ path: 'missing-page' })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.include.errors.pageNotFound',
        'There is no page at "missing-page".',
        { path: 'missing-page' }
      )
    })

    it('asks the resolver for the include-failed key on any other error', async () => {
      stubFetch({ includeResult: 'networkError' })
      await mountInclude({ path: 'broken-page' })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.include.errors.includeFailed',
        'The page "broken-page" could not be included.',
        { path: 'broken-page' }
      )
    })

    it("renders whatever the resolver returns, not the component's own literal", async () => {
      i18nT.mockResolvedValueOnce('Il n’y a pas de page à cette adresse.')
      stubFetch({ includeResult: 'notFound' })
      const el = await mountInclude({ path: 'missing-page' })

      expect(el.textContent).toContain('Il n’y a pas de page à cette adresse.')
      expect(el.textContent).not.toContain('There is no page at')
    })

    it('asks the resolver for the self-include key, with no params', async () => {
      stubFetch({ pathname: '/same-page' })
      await mountInclude({ path: 'same-page' })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.include.errors.selfInclude',
        'This page includes itself.'
      )
    })

    it('asks the resolver for the loop key, with the path as an interpolation param', async () => {
      stubFetch()
      const outer = await mountInclude({ path: '/Ancestor-Page/' })
      await mountInclude({ path: 'ancestor-page', parent: outer })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.include.errors.loop',
        'Including "ancestor-page" here would loop: it is already open above.',
        { path: 'ancestor-page' }
      )
    })

    it('asks the resolver for the max-depth key, with maxDepth as an interpolation param', async () => {
      stubFetch({ pathname: '/root' })
      let current = document.body
      for (let i = 0; i < 3; i++) {
        current = await mountInclude({ path: `level-${i}`, parent: current })
      }
      await mountInclude({ path: 'level-3', parent: current })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.include.errors.maxDepth',
        'Includes are nested more than 3 pages deep.',
        { maxDepth: 3 }
      )
    })

    it('asks the resolver for the password-protected key, with the path as an interpolation param', async () => {
      stubFetch({ page: stubPage({ isLocked: true }) })
      await mountInclude({ path: 'locked-page' })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.include.errors.passwordProtected',
        'The page "locked-page" is password protected. Open it to enter the password.',
        { path: 'locked-page' }
      )
    })
  })

  /*
   * OpenProject #954: before this fix, `_loadNestedBlocks()` always fetched `/_blocks/${tag}.js`,
   * which 404s for a custom block -- it has no such flat file, only a per-site
   * `/_blocks/custom/:siteId/:id.js` route. This mounts a transcluded page whose content brings an
   * undefined `<block-widget>` element with it and asserts the component resolves that tag through
   * `getBlockImportUrl()` instead of guessing a URL itself.
   */
  it("resolves a nested block's import URL through getBlockImportUrl(), not a hardcoded flat path", async () => {
    stubFetch({ page: stubPage({ render: '<p>Text</p><block-widget></block-widget>' }) })

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
