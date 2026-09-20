import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Mocked rather than stubbed through `fetch` so this suite can assert on *which* tag the component
 * asked to resolve; `getBlockImportUrl`'s own URL building has its own suite.
 */
vi.mock('../shared/config.js', () => ({
  getBlockImportUrl: vi.fn(async (tag) => `/mock-blocks/${tag}.js`)
}))

/*
 * Mocked for the same reason: this suite is about `connectedCallback`'s own branching, and a real
 * `t()` would land `_error` only after an actual (failing) network round trip, unlike every other
 * awaited step here. `vi.hoisted` so `i18nT` is assignable outside the hoisted `vi.mock` factory,
 * for the tests that assert on its calls.
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
 * Stubs both hops the block makes: the site lookup (`../shared/site.js`) and the include route
 * itself. `pathname` is what it reads its own path and locale off.
 */
function stubFetch({
  page = stubPage(),
  pathname = '/current-page',
  locales = { primary: 'en', active: ['en'] },
  includeResult = 'success'
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

function includeCalls(fetchMock) {
  return fetchMock.mock.calls.filter(([url]) => url.includes('/pages/include'))
}

/**
 * `parent` is an already-mounted `<block-include>` this one nests inside -- the shape
 * `_ancestorPaths()` climbs to find a cycle.
 */
const mountInclude = ({ path = 'target-page', locale = '', showTitle = false, parent } = {}) =>
  mountBlock('block-include', {
    // -> A real HTML attribute, not just a JS property: `_ancestorPaths()` reads an ancestor's own
    //    `path` via `getAttribute`, the shape `::block-include{path="..."}` produces.
    attrs: { path },
    props: { locale, showTitle },
    parent,
    // -> Two fetch hops deep (site -> include); one macrotask turn drains the microtasks of both
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
    The picker leaves the attribute literally present with the string "false" when an author toggles
    Show Title on and back off, and Lit's stock Boolean converter reads any present attribute as
    true.
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
    const inner = await mountInclude({ path: 'ancestor-page', parent: outer })

    expect(inner.textContent).toContain('would loop')
    expect(includeCalls(fetchMock)).toHaveLength(1)
  })

  it('refuses nesting deeper than MAX_DEPTH (3)', async () => {
    stubFetch({ pathname: '/root' })
    let current = document.body
    for (let i = 0; i < 3; i++) {
      current = await mountInclude({ path: `level-${i}`, parent: current })
    }
    // -> Root page + 3 already-open includes = a chain of 4, past MAX_DEPTH
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
   * A custom block has no flat `/_blocks/${tag}.js` file -- only a per-site
   * `/_blocks/custom/:siteId/:id.js` route -- so a URL guessed from the tag 404s.
   */
  it("resolves a nested block's import URL through getBlockImportUrl(), not a hardcoded flat path", async () => {
    stubFetch({ page: stubPage({ render: '<p>Text</p><block-widget></block-widget>' }) })

    await mountInclude({ path: 'page-with-nested-block' })
    // -> `_loadNestedBlocks()`'s `import()` needs a turn past `mountInclude`'s own waits to settle
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
