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

const SITE_ID = 'site-1'

function stubPage(overrides = {}) {
  return {
    title: 'Included Page',
    render: '<p>Included content</p>',
    isLocked: false,
    ...overrides
  }
}

/**
 * Appends a `<block-include>` and waits for the fetch `connectedCallback` always kicks off.
 * `parent`, if given, is an already-mounted `<block-include>` this one nests inside -- the shape
 * `_ancestorPaths()` climbs to find a cycle.
 */
async function mountInclude({ path = 'target-page', locale = '', showTitle = false, parent } = {}) {
  const el = document.createElement('block-include')
  // -> `path` as a real HTML attribute, not just a JS property: `_ancestorPaths()` reads a nested
  //    include's OWN `path` off its ancestor elements via `getAttribute`, the same shape the
  //    markdown renderer's `::block-include{path="..."}` actually produces.
  el.setAttribute('path', path)
  el.locale = locale
  el.showTitle = showTitle
  ;(parent ?? document.body).appendChild(el)
  await el.updateComplete
  // -> connectedCallback's API_CLIENT.get is awaited but not blocking connectedCallback itself
  await new Promise((resolve) => queueMicrotask(resolve))
  await el.updateComplete
  return el
}

describe('block-include', () => {
  beforeEach(() => {
    globalThis.WIKI_STATE = {
      site: { id: SITE_ID },
      page: { path: 'current-page', locale: 'en' }
    }
    globalThis.API_CLIENT = {
      get: vi.fn(() => ({ json: () => Promise.resolve(stubPage()) }))
    }
  })

  afterEach(() => {
    document.body.replaceChildren()
    delete globalThis.WIKI_STATE
    delete globalThis.API_CLIENT
  })

  it('fetches the requested path/locale and renders the included page', async () => {
    const el = await mountInclude({ path: 'target-page', locale: 'fr' })

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(`sites/${SITE_ID}/pages/include`, {
      searchParams: { path: 'target-page', locale: 'fr' }
    })
    expect(el.textContent).toContain('Included content')
  })

  it("defaults locale to the current page's own locale when none is given", async () => {
    await mountInclude({ path: 'target-page', locale: '' })

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${SITE_ID}/pages/include`,
      expect.objectContaining({ searchParams: { path: 'target-page', locale: 'en' } })
    )
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
    const el = document.createElement('block-include')
    el.setAttribute('path', 'target-page')
    el.setAttribute('showtitle', 'false')
    document.body.appendChild(el)
    await el.updateComplete
    await new Promise((resolve) => queueMicrotask(resolve))
    await el.updateComplete

    expect(el.showTitle).toBe(false)
    expect(el.querySelector('h2')).toBeNull()
  })

  it('renders into the light DOM, not a shadow root, so the article stylesheet reaches it', async () => {
    const el = await mountInclude()
    expect(el.shadowRoot).toBeNull()
  })

  it('refuses a page naming itself, before any request goes out', async () => {
    globalThis.WIKI_STATE.page.path = 'same-page'
    const el = await mountInclude({ path: 'same-page' })

    expect(el.textContent).toContain('This page includes itself')
    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('refuses a cycle through a currently-open ancestor include, case/slash-insensitively', async () => {
    const outer = await mountInclude({ path: '/Ancestor-Page/' })
    // -> The nested include is appended as a child of the outer one's rendered content
    const inner = await mountInclude({ path: 'ancestor-page', parent: outer })

    expect(inner.textContent).toContain('would loop')
    expect(globalThis.API_CLIENT.get).toHaveBeenCalledTimes(1) // only the outer include fetched
  })

  it('refuses nesting deeper than MAX_DEPTH (3)', async () => {
    globalThis.WIKI_STATE.page.path = 'root'
    let current = document.body
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('block-include')
      el.setAttribute('path', `level-${i}`)
      current.appendChild(el)
      await el.updateComplete
      await new Promise((resolve) => queueMicrotask(resolve))
      current = el
    }
    // -> A 4th level: root page + 3 already-open includes = chain length 4, over MAX_DEPTH (3)
    const tooDeep = document.createElement('block-include')
    tooDeep.setAttribute('path', 'level-3')
    current.appendChild(tooDeep)
    await tooDeep.updateComplete
    await new Promise((resolve) => queueMicrotask(resolve))

    expect(tooDeep.textContent).toContain('nested more than 3 pages deep')
  })

  it('shows a not-found message for a 404 response', async () => {
    globalThis.API_CLIENT.get = vi.fn(() => ({
      json: () => Promise.reject({ response: { status: 404 } })
    }))
    const el = await mountInclude({ path: 'missing-page' })

    expect(el.textContent).toContain('There is no page at "missing-page"')
  })

  it('shows a generic failure message for a non-404 error', async () => {
    globalThis.API_CLIENT.get = vi.fn(() => ({
      json: () => Promise.reject(new Error('network down'))
    }))
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
    globalThis.API_CLIENT.get = vi.fn(() => ({
      json: () => Promise.resolve(stubPage({ render: '<p>Text</p><block-widget></block-widget>' }))
    }))

    await mountInclude({ path: 'page-with-nested-block' })
    // -> `_loadNestedBlocks()`'s own `import()` attempt needs a further turn past `mountInclude`'s
    //    own waits to settle (it rejects, since nothing is actually served at the mocked URL)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getBlockImportUrl).toHaveBeenCalledWith('block-widget')
  })

  it('points at the unlock prompt rather than asking for a password itself, for a locked page', async () => {
    globalThis.API_CLIENT.get = vi.fn(() => ({
      json: () => Promise.resolve(stubPage({ isLocked: true }))
    }))
    const el = await mountInclude({ path: 'locked-page' })

    expect(el.textContent).toContain('password protected')
    expect(el.textContent).toContain('Open it to enter the password')
  })
})
