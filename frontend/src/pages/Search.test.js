import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Search from './Search.vue'
import { extractTags, MAX_QUERY_LENGTH } from './searchTags.js'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * The regex `extractTags()` replaces (see `searchTags.js`'s own header comment for the full
 * derivation). Kept here, private to the test file, purely as an oracle to differential-test
 * against on cases too fiddly to hand-verify -- never re-exported for production use.
 */
const legacyTagsInQueryRgx = /#[a-z0-9-㐀-䶿一-鿿]+(?=(?:[^"]*(?:")[^"]*(?:"))*[^"]*$)/g

function legacyExtractTags(query) {
  return Array.from(query.matchAll(legacyTagsInQueryRgx)).map((t) => t[0].substring(1))
}

describe('extractTags', () => {
  it('extracts every tag from an unquoted query', () => {
    expect(extractTags('#one #two #three')).toEqual(['one', 'two', 'three'])
  })

  it('extracts no tags from an empty or tag-less query', () => {
    expect(extractTags('')).toEqual([])
    expect(extractTags('just some words')).toEqual([])
  })

  it('excludes a #tag-shaped token that lies inside a quoted phrase', () => {
    expect(extractTags('#a "quoted #nope phrase" #b')).toEqual(['a', 'b'])
  })

  it('excludes multiple quoted phrases, keeping tags outside each', () => {
    expect(extractTags('#a "one #x" #b "two #y" #c')).toEqual(['a', 'b', 'c'])
  })

  it('matches CJK tag characters, same character class as the old regex', () => {
    expect(extractTags('#日本語 #中文')).toEqual(['日本語', '中文'])
  })

  it('reproduces the old regex on an odd number of quotes (one stray quote)', () => {
    const query = '#a "b #c'
    expect(extractTags(query)).toEqual(legacyExtractTags(query))
    expect(extractTags(query)).toEqual(['c'])
  })

  it('reproduces the old regex on an odd number of quotes (three quotes)', () => {
    const query = '#a "b" #c "d'
    expect(extractTags(query)).toEqual(legacyExtractTags(query))
    expect(extractTags(query)).toEqual([])
  })

  it('reproduces the old regex across a table of quoted/unquoted/odd-quote queries', () => {
    const cases = [
      '#one #two',
      '#one "two #skip" #three',
      'no tags here',
      '#a"b',
      '"#a" #b',
      '#a "b" "c #d" #e',
      '#a "b #c" "d',
      '"""',
      '#a""#b',
      '"unterminated #a #b'
    ]
    for (const query of cases) {
      expect(extractTags(query)).toEqual(legacyExtractTags(query))
    }
  })

  it('completes promptly on a ~100KB adversarial query (long tag run + many quotes)', () => {
    // Deliberately NOT differential-tested against `legacyExtractTags` here -- this exact shape
    // (a long tag run followed by a long run of quotes) is the quadratic-backtracking case being
    // fixed, so running the old regex against it would defeat the point of the test.
    const query = `#${'a'.repeat(50_000)}${'"'.repeat(50_000)}`
    const start = performance.now()
    const tags = extractTags(query)
    const elapsedMs = performance.now() - start

    expect(elapsedMs).toBeLessThan(500)
    expect(tags).toEqual(['a'.repeat(50_000)])
  })
})

describe('MAX_QUERY_LENGTH', () => {
  it('is a positive, generous bound', () => {
    expect(MAX_QUERY_LENGTH).toBeGreaterThan(100)
  })
})

/*
 * `useMinWidth` (via `useScreen`) calls `window.matchMedia` -- happy-dom supplies one, but this
 * mirrors `Index.test.js`'s own defensive stub rather than assuming so, since nothing else in this
 * file needs the real implementation.
 */
beforeEach(() => {
  window.matchMedia =
    window.matchMedia ??
    vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  vi.clearAllMocks()
})

async function mountSearch() {
  const router = await createTestRouter(['/_search'], '/_search')

  const { wrapper } = mountWithApp(Search, {
    router,
    stubs: {
      HeaderNav: true,
      FooterNav: true,
      MainOverlayDialog: true
    }
  })
  activeWrapper = wrapper
  await flushPromises()

  return { wrapper }
}

function resultItem(locale, path, title) {
  return {
    locale,
    path,
    title,
    description: '',
    icon: '',
    highlight: '',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

/**
 * WP #1728: `state.results` is replaced wholesale on any filter change (the `deep: true` watcher on
 * `state.params`), but the `w-item` row for each result had no `:key` -- Vue fell back to patching
 * rows in place by index instead of keying them by identity, reusing a row's DOM element (and any
 * component-internal state it held: focus, scroll position, in-flight transitions) across two
 * completely unrelated results. This asserts a row's DOM element is actually replaced, not patched
 * in place, when the result set changes to a different page of results at the same array index.
 */
describe('Search.vue results list keying (WP #1728)', () => {
  it('replaces a row DOM element (does not reuse it) when the result set changes to unrelated results', async () => {
    const { wrapper } = await mountSearch()

    wrapper.vm.state.results = [
      resultItem('en', 'page-one', 'Page One'),
      resultItem('en', 'page-two', 'Page Two')
    ]
    await flushPromises()

    // -> Select the row by the actual link it renders (`localizedPagePath`, no locale prefix here
    //    since `siteStore.localeRouting.useLocales` defaults falsy) rather than a class guess: the
    //    results list is the only `w-item v-for` in the template keyed off `state.results`.
    const firstRowBefore = wrapper.find('a[href="/page-one"]')
    expect(firstRowBefore.exists()).toBe(true)
    const firstElBefore = firstRowBefore.element

    // -> A wholesale replacement: an unrelated result set with no keys in common with the first,
    //    same array length and same index-0 position -- exactly the "any filter change" case the
    //    bug description calls out.
    wrapper.vm.state.results = [
      resultItem('en', 'page-three', 'Page Three'),
      resultItem('en', 'page-four', 'Page Four')
    ]
    await flushPromises()

    const firstRowAfter = wrapper.find('a[href="/page-three"]')
    expect(firstRowAfter.exists()).toBe(true)
    expect(firstRowAfter.element).not.toBe(firstElBefore)

    // -> The stale row is gone outright, not merely relabeled in place
    expect(wrapper.find('a[href="/page-one"]').exists()).toBe(false)
  })
})

/**
 * Cobalt typography role-table conformance (OpenProject #2984, "Search" §3): the empty-query
 * prompt carried no type role of its own before this -- just the ambient inherited size/color --
 * so it is the one role in this table that needed a real fix rather than already resolving
 * correctly through the existing color tokens.
 */
describe('Search.vue empty-query prompt (OpenProject #2984)', () => {
  it('renders the empty-query prompt in its own italic type role when no search has run', async () => {
    const { wrapper } = await mountSearch()

    const prompt = wrapper.find('.layout-search-empty-prompt')
    expect(prompt.exists()).toBe(true)
    expect(prompt.find('em').exists()).toBe(true)
    // -> Not the "no results for a query" wording -- that is a different role, unstyled by this WP
    expect(wrapper.find('.layout-search-empty-prompt').text()).not.toBe('')
  })

  it('does not render the empty-query prompt once a query has actually matched nothing', async () => {
    const { wrapper } = await mountSearchWithResponse({
      results: [],
      totalHits: 0,
      totalHitsApproximate: false,
      suggestion: null
    })

    expect(wrapper.find('.layout-search-empty-prompt').exists()).toBe(false)
  })
})

/**
 * OpenProject #2006: a restricted reader's page rules can drop rows the search engine itself
 * matched, which makes the reported `totalHits` a floor rather than an exact count -- see
 * `backend/modules/search/db/search.test.ts` for the backend half (the flag itself) and this file
 * for the frontend half (labeling it). Real i18n messages, not the empty stub `TagsBrowse.test.js`
 * uses, since what is under test here IS the wording the two keys (`search.totalResults` /
 * `search.totalResultsApprox`) produce. Also carries `search.loadMore`, shared with the offset-paging
 * tests below (OpenProject #2001) since both groups mount the real `Search` component.
 */
function createSearchI18n() {
  return createTestI18n({
    search: {
      results: 'Search Results',
      emptyQuery: 'Enter a query in the search field above and press Enter.',
      totalResults: 'No result | {0} result | {0} results',
      totalResultsApprox: 'No result | At least {0} result | At least {0} results',
      loadMore: 'Load More',
      modeKeyword: 'Keyword',
      modeSemantic: 'Semantic',
      modeToggleLabel: 'Search Mode'
    }
  })
}

const FIXTURE_PAGE = {
  id: 'p1',
  path: 'some/page',
  locale: 'en',
  title: 'Some Page',
  description: null,
  icon: null,
  tags: [],
  updatedAt: '2026-08-01T00:00:00.000Z',
  relevancy: 1,
  highlight: null
}

const FIXTURE_PAGE_A = {
  id: 'p1',
  path: 'page-a',
  locale: 'en',
  title: 'Page A',
  description: null,
  icon: null,
  tags: [],
  updatedAt: '2026-08-01T00:00:00.000Z',
  relevancy: 1,
  highlight: null
}

const FIXTURE_PAGE_B = { ...FIXTURE_PAGE_A, id: 'p2', path: 'page-b', title: 'Page B' }
const FIXTURE_PAGE_C = { ...FIXTURE_PAGE_A, id: 'p3', path: 'page-c', title: 'Page C' }

async function createSearchRouter(initialPath) {
  const router = await createTestRouter(
    [{ path: '/_search', component: Search }, '/:pathMatch(.*)*'],
    initialPath
  )
  return router
}

async function mountSearchWithResponse(searchResponse) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  const userStore = useUserStore()

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(searchResponse) })

  const router = await createSearchRouter('/_search?q=onboarding')
  const i18n = createSearchI18n()
  const wrapper = mount(Search, {
    global: {
      plugins: [router, i18n],
      // -> Real HeaderNav/FooterNav/MainOverlayDialog pull in more stores and API calls than this
      //    test cares about; stubbed by name so the page around them still renders for real.
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  activeWrapper = wrapper
  await flushPromises()
  return { wrapper, siteStore, userStore, i18n }
}

/**
 * Mounts against `initialPath`, queuing `firstResponse` ahead of the immediate `route.query`
 * watcher's own search request -- the same mount-time ordering `TagsBrowse.test.js` documents for
 * its own route-driven watcher.
 */
async function mountSearchWithOffset(initialPath = '/_search?q=test', firstResponse) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  if (firstResponse) {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(firstResponse) })
  }

  const router = await createSearchRouter(initialPath)
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createSearchI18n()],
      // -> Layout chrome, irrelevant to offset paging. HeaderNav in particular pulls in
      //    HeaderSearch, whose onMounted() unconditionally focuses its search field whenever the
      //    route starts with `/_search` -- exactly this page's own route -- which throws under
      //    happy-dom with nothing real to focus.
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  activeWrapper = wrapper
  await flushPromises()
  return { wrapper, router, siteStore }
}

function findLoadMoreButton(wrapper) {
  return wrapper.findAll('button').find((b) => b.text() === 'Load More')
}

/**
 * Mounts with `siteStore.features.semanticSearch` set before the component's own `onMounted()`
 * runs, and (like `mountSearchWithOffset`) queues `firstResponse` ahead of the immediate
 * `route.query` watcher's own request when one is given.
 */
async function mountSearchWithMode({
  semanticEnabled = true,
  initialPath = '/_search?q=onboarding',
  firstResponse
} = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.features.semanticSearch = semanticEnabled

  if (firstResponse) {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(firstResponse) })
  }

  const router = await createSearchRouter(initialPath)
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createSearchI18n()],
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  activeWrapper = wrapper
  await flushPromises()
  return { wrapper, router, siteStore }
}

describe('Search.vue totalHitsApproximate labeling (OpenProject #2006)', () => {
  it('shows the exact-count label when the backend reports an exact total', async () => {
    const { wrapper } = await mountSearchWithResponse({
      results: [FIXTURE_PAGE],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    expect(wrapper.vm.state.totalApproximate).toBe(false)
    expect(wrapper.text()).toContain('1 result')
    expect(wrapper.text()).not.toContain('At least')
  })

  it('shows the approximate-count label when page rules dropped rows from this page', async () => {
    const { wrapper } = await mountSearchWithResponse({
      results: [FIXTURE_PAGE],
      totalHits: 1,
      totalHitsApproximate: true,
      suggestion: null
    })

    expect(wrapper.vm.state.totalApproximate).toBe(true)
    expect(wrapper.text()).toContain('At least 1 result')
  })

  it('resets to the exact label on a later search that reports nothing approximate', async () => {
    const { wrapper, siteStore } = await mountSearchWithResponse({
      results: [FIXTURE_PAGE],
      totalHits: 1,
      totalHitsApproximate: true,
      suggestion: null
    })
    expect(wrapper.vm.state.totalApproximate).toBe(true)

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [FIXTURE_PAGE],
          totalHits: 1,
          totalHitsApproximate: false,
          suggestion: null
        })
    })
    siteStore.search = 'onboarding guide'
    await wrapper.vm.performSearch()
    await flushPromises()

    expect(wrapper.vm.state.totalApproximate).toBe(false)
    expect(wrapper.text()).not.toContain('At least')
  })
})

describe('Search.vue offset paging (OpenProject #2001)', () => {
  it('sends offset 0 on the first page of a fresh search', async () => {
    const { wrapper } = await mountSearchWithOffset('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 3,
      suggestion: null
    })

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ offset: 0 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(wrapper.vm.state.offset).toBe(2)
  })

  it('loadMore requests the next page at the current offset and appends rather than replaces', async () => {
    const { wrapper } = await mountSearchWithOffset('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 3,
      suggestion: null
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_C], totalHits: 3, suggestion: null })
    })

    await wrapper.vm.loadMore()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ offset: 2 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1', 'p2', 'p3'])
    expect(wrapper.vm.state.offset).toBe(3)
  })

  it('shows the load-more control while more results remain, and hides it once exhausted', async () => {
    const { wrapper } = await mountSearchWithOffset('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 3,
      suggestion: null
    })
    expect(findLoadMoreButton(wrapper)).toBeTruthy()

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_C], totalHits: 3, suggestion: null })
    })
    await wrapper.vm.loadMore()
    await flushPromises()

    expect(findLoadMoreButton(wrapper)).toBeFalsy()
  })

  it('never shows the load-more control when a single page already covers the total', async () => {
    const { wrapper } = await mountSearchWithOffset('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 2,
      suggestion: null
    })

    expect(findLoadMoreButton(wrapper)).toBeFalsy()
  })

  it('a fresh search resets the offset instead of continuing to append onto the prior one', async () => {
    const { wrapper } = await mountSearchWithOffset('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 5,
      suggestion: null
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_C], totalHits: 5, suggestion: null })
    })
    await wrapper.vm.loadMore()
    await flushPromises()
    expect(wrapper.vm.state.offset).toBe(3)

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_A], totalHits: 5, suggestion: null })
    })
    await wrapper.vm.performSearch()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ offset: 0 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1'])
    expect(wrapper.vm.state.offset).toBe(1)
  })
})

/**
 * OpenProject #3136 -- `watch(() => state.params, debounce(performSearch, 500), { deep: true })`
 * let Vue's own `(newValue, oldValue, onCleanup)` watch-callback arguments flow straight through
 * the debounced wrapper into `performSearch(append = false)`, so `append` received the (always
 * truthy) new `state.params` object instead of defaulting to `false`. `runSearchRequest` then
 * reused the stale `state.offset` left over from the initial load instead of resetting to 0,
 * which -- once `state.offset` had advanced past `totalHits` -- made every filter/sort change
 * request a page past the end of the results and come back empty.
 */
describe('Search.vue filter/sort changes re-search from offset 0 (OpenProject #3136)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resets to offset 0 when a param changes after the offset has advanced past it, instead of reusing the stale offset', async () => {
    const { wrapper } = await mountSearchWithOffset('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 2,
      suggestion: null
    })
    expect(wrapper.vm.state.offset).toBe(2)

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_A], totalHits: 2, suggestion: null })
    })

    wrapper.vm.state.params.orderBy = 'title'
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ offset: 0 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1'])
  })

  it('re-searches from offset 0 for every state.params field, not just sort order', async () => {
    const { wrapper } = await mountSearchWithOffset('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 2,
      suggestion: null
    })
    expect(wrapper.vm.state.offset).toBe(2)

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_A], totalHits: 2, suggestion: null })
    })

    wrapper.vm.state.params.filterPublishState = 'published'
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ offset: 0 })
      })
    )
  })
})

/**
 * OpenProject #2697 -- handoff 2's Search screen.
 *
 * Two deliberate removals from 2.x and one new row shape. The removals are only half visible from
 * here: the dark radial band behind the card is CSS, and is measured in `Search.layout.test.js`
 * alongside the 150px trailing column and the pinned header strips. What a mounted component can
 * answer -- and what the WP asks for by name -- is that the floating Back button is gone from the
 * DOM ENTIRELY rather than merely hidden by a media query, that no handler was left behind for it,
 * and that a result row renders the five parts the design gives it.
 */
const FIXTURE_RICH_RESULT = {
  id: 'p9',
  path: 'docs/ingest/credentials',
  locale: 'en',
  title: 'Rotating ingest credentials',
  description: 'How and when to roll the ingest worker credentials.',
  icon: 'tabler:file-text',
  tags: ['runbook', 'security'],
  updatedAt: '2026-08-01T00:00:00.000Z',
  relevancy: 1,
  highlight: 'the worker reads its <b>credentials</b> from the secret store'
}

describe('Search.vue result rows and the removed Back control (OpenProject #2697)', () => {
  it('renders no Back control at all, and exposes no handler for one', async () => {
    const { wrapper } = await mountSearchWithResponse({
      results: [FIXTURE_RICH_RESULT],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    // -> Gone from the DOM, not hidden: the class the old rule keyed off no longer exists either
    expect(wrapper.find('.layout-search-back').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('circle-arrow-left')
    // -> And no dead handler behind it. `<script setup>` bindings are exposed on the instance, so
    //    a surviving `goBack` would be a function here rather than `undefined`.
    expect(wrapper.vm.goBack).toBeUndefined()
  })

  it('renders each result as a link carrying plate, title, description, path and highlight', async () => {
    const { wrapper, userStore, i18n } = await mountSearchWithResponse({
      results: [FIXTURE_RICH_RESULT],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    const rows = wrapper.findAll('.layout-search-row')
    expect(rows).toHaveLength(1)

    const row = rows[0]
    expect(row.element.tagName).toBe('A')
    expect(row.attributes('href')).toBe('/docs/ingest/credentials')
    expect(row.find('.layout-search-plate').exists()).toBe(true)
    expect(row.find('.layout-search-rowtitle').text()).toBe('Rotating ingest credentials')
    expect(row.find('.layout-search-rowdesc').text()).toBe(
      'How and when to roll the ingest worker credentials.'
    )
    expect(row.find('.layout-search-rowpath').text()).toBe('/docs/ingest/credentials')

    /*
      OpenProject #2716: this date used to go through `humanizeDate` (the long absolute form), the
      same as tag results and Inbox Watching, while the page view's own "Last modified" line already
      used the short recent form -- so the same fact about the same page read differently depending
      on which list it was found in. `FIXTURE_RICH_RESULT.updatedAt` is a fixed 2026-08-01 date, well
      beyond `formatRecent`'s 7-day window, so this asserts against `formatRecent`'s own (fallback)
      output rather than a hand-written absolute string.
    */
    expect(row.find('.layout-search-rowdate').text()).toBe(
      userStore.formatRecent(i18n.global.t, FIXTURE_RICH_RESULT.updatedAt)
    )

    // -> The matched-term treatment is the shared `.text-highlight`, not a Search-only class
    const excerpt = row.find('.layout-search-rowexcerpt')
    expect(excerpt.classes()).toContain('text-highlight')
    expect(excerpt.find('b').text()).toBe('credentials')
  })

  /*
    OpenProject #3122: a semantic result carries `chunkText` (the matched embedding chunk) and no
    `highlight` -- the route/schema fix restores this field to the payload, and this is the frontend
    half: render it as the excerpt, as plain text rather than `v-html`, since it is raw stored
    content, not pre-escaped highlight markup with `<b>` wrapping.
  */
  it("renders a semantic result's chunkText as its excerpt when it carries no highlight", async () => {
    const { wrapper } = await mountSearchWithResponse({
      results: [
        {
          ...FIXTURE_RICH_RESULT,
          highlight: undefined,
          chunkText: 'the worker reads its credentials from the secret store',
          chunkIndex: 2,
          distance: 0.12,
          hop: 1
        }
      ],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    const row = wrapper.find('.layout-search-row')
    const excerpt = row.find('.layout-search-rowexcerpt')
    expect(excerpt.exists()).toBe(true)
    expect(excerpt.classes()).not.toContain('text-highlight')
    expect(excerpt.find('b').exists()).toBe(false)
    expect(excerpt.text()).toBe('the worker reads its credentials from the secret store')
  })

  it('shows the recent form, not the legacy absolute one, for a page updated within the last week', async () => {
    const recentUpdatedAt = Temporal.Now.instant().subtract({ hours: 26 }).toString()
    const { wrapper, userStore, i18n } = await mountSearchWithResponse({
      results: [{ ...FIXTURE_RICH_RESULT, updatedAt: recentUpdatedAt }],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    expect(wrapper.find('.layout-search-rowdate').text()).toBe(
      userStore.formatRecent(i18n.global.t, recentUpdatedAt)
    )
  })

  it('renders the placeholder, not an empty date, for a result with no updatedAt', async () => {
    const { wrapper } = await mountSearchWithResponse({
      results: [{ ...FIXTURE_RICH_RESULT, updatedAt: null }],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    expect(wrapper.find('.layout-search-rowdate').text()).toBe('---')
  })

  it('puts the tags in the trailing column, and renders none of it when a page has no tags', async () => {
    const { wrapper } = await mountSearchWithResponse({
      results: [
        FIXTURE_RICH_RESULT,
        { ...FIXTURE_RICH_RESULT, id: 'p10', path: 'plain', tags: [] }
      ],
      totalHits: 2,
      totalHitsApproximate: false,
      suggestion: null
    })

    const [tagged, untagged] = wrapper.findAll('.layout-search-row')

    expect(tagged.find('.layout-search-rowdate').exists()).toBe(true)
    expect(tagged.findAll('.layout-search-rowtags .w-chip').map((c) => c.text())).toEqual([
      'runbook',
      'security'
    ])

    // -> No empty tag row left drawing a gap under the date
    expect(untagged.find('.layout-search-rowdate').exists()).toBe(true)
    expect(untagged.find('.layout-search-rowtags').exists()).toBe(false)
  })
})

describe('Search.vue Keyword/Semantic mode toggle (OpenProject #3105)', () => {
  it('is absent entirely -- not merely disabled -- when the site has not enabled semantic search', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: false,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })

    expect(wrapper.find('.layout-search-modetoggle').exists()).toBe(false)
  })

  it('is present when the site has semantic search enabled', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })

    expect(wrapper.find('.layout-search-modetoggle').exists()).toBe(true)
  })

  it('switching to Semantic re-queries pages/search/semantic, preserving the typed query text', async () => {
    const { wrapper, siteStore } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE_A], totalHits: 1, suggestion: null }
    })
    expect(siteStore.search).toBe('onboarding')

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [FIXTURE_PAGE_B],
          totalHits: 1,
          totalHitsApproximate: false,
          suggestion: null
        })
    })

    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    // -> The query box itself is untouched by the mode switch
    expect(siteStore.search).toBe('onboarding')
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.objectContaining({ query: 'onboarding', offset: 0 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p2'])
  })

  it('switching back to Keyword re-queries pages/search fresh, not a stale cache of the earlier results', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE_A], totalHits: 1, suggestion: null }
    })

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_B], totalHits: 1, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p2'])

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_A], totalHits: 1, suggestion: null })
    })
    wrapper.vm.setSearchMode('keyword')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ query: 'onboarding', offset: 0 })
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1'])
  })

  it('sends locales as a single-element comma-joined list when one locale filter is selected', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    wrapper.vm.state.params.filterLocale = ['en']

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.objectContaining({ locales: 'en' })
      })
    )
  })

  it('sends locales as a comma-joined list when multiple locale filters are selected', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    wrapper.vm.state.params.filterLocale = ['en', 'fr']

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.objectContaining({ locales: 'en,fr' })
      })
    )
  })

  it('omits locales when no locale filter is selected', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    const lastCall = API_CLIENT.get.mock.calls.at(-1)
    expect(lastCall[1].searchParams).not.toHaveProperty('locales')
  })

  it('sends path/tags/editor/publishState filters in Semantic mode, matching the Keyword param names', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    wrapper.vm.state.params.filterPath = 'docs'
    wrapper.vm.state.selectedTags = ['alpha', 'beta']
    wrapper.vm.state.params.filterEditor = 'markdown'
    wrapper.vm.state.params.filterPublishState = 'published'

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.objectContaining({
          path: 'docs',
          tags: 'alpha,beta',
          editor: 'markdown',
          publishState: 'published'
        })
      })
    )
  })

  it('omits path/tags/editor/publishState from the semantic request when unset', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    const lastCall = API_CLIENT.get.mock.calls.at(-1)
    expect(lastCall[1].searchParams).not.toHaveProperty('path')
    expect(lastCall[1].searchParams).not.toHaveProperty('tags')
    expect(lastCall[1].searchParams).not.toHaveProperty('editor')
    expect(lastCall[1].searchParams).not.toHaveProperty('publishState')
  })

  it('keeps the sort/filter sidebar visible in Semantic mode, hiding only Sort By', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    expect(wrapper.find('.layout-search-sd').attributes('style') ?? '').not.toContain(
      'display: none'
    )
    expect(wrapper.findAll('.section-header').at(0).text()).toBe('search.sortBy')

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    // -> Still shown, not hidden entirely: Path/Tags/Locale/Editor/Publish State remain usable
    expect(wrapper.find('.layout-search-sd').attributes('style') ?? '').not.toContain(
      'display: none'
    )
    // -> Sort By is the one control still gone -- its section-header text no longer appears, and
    //    "Filters" (the only remaining section-header inside the sidebar) is now first
    expect(wrapper.findAll('.section-header').map((el) => el.text())).not.toContain('search.sortBy')
    expect(wrapper.findAll('.section-header').at(0).text()).toBe('search.filters')
  })

  it('an empty query resets results in Semantic mode instead of calling the API', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      initialPath: '/_search'
    })
    const callsBefore = API_CLIENT.get.mock.calls.length

    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    expect(API_CLIENT.get.mock.calls.length).toBe(callsBefore)
    expect(wrapper.vm.state.results).toEqual([])
  })

  it('setSearchMode is a no-op when already in the requested mode', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    const callsBefore = API_CLIENT.get.mock.calls.length

    wrapper.vm.setSearchMode('keyword')
    await flushPromises()

    expect(API_CLIENT.get.mock.calls.length).toBe(callsBefore)
  })
})

/**
 * OpenProject #3138: `HeaderSearch.vue`'s own new mode toggle carries its pending mode as a `mode`
 * query param on the navigation to `/_search` -- these confirm this page reads it back on load (and
 * on any later route-query change) to initialize/update `state.mode`, so a semantic search started
 * from the header lands here already in Semantic mode rather than requiring a second click.
 */
describe('Search.vue reads the mode query param (OpenProject #3138)', () => {
  it('initializes state.mode to semantic and queries the semantic endpoint when ?mode=semantic', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      initialPath: '/_search?q=onboarding&mode=semantic',
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })

    expect(wrapper.vm.state.mode).toBe('semantic')
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.objectContaining({ query: 'onboarding' })
      })
    )
  })

  it('does not honour ?mode=semantic when the site has no semantic search available', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: false,
      initialPath: '/_search?q=onboarding&mode=semantic',
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })

    expect(wrapper.vm.state.mode).toBe('keyword')
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ query: 'onboarding' })
      })
    )
  })

  it('defaults to keyword mode when no mode param is present', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      initialPath: '/_search?q=onboarding',
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })

    expect(wrapper.vm.state.mode).toBe('keyword')
  })

  it('switches back to keyword mode on a route-query change carrying ?mode=keyword', async () => {
    const { wrapper, router } = await mountSearchWithMode({
      semanticEnabled: true,
      initialPath: '/_search?q=onboarding&mode=semantic',
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    expect(wrapper.vm.state.mode).toBe('semantic')

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE], totalHits: 1, suggestion: null })
    })
    await router.push({ path: '/_search', query: { q: 'onboarding', mode: 'keyword' } })
    await flushPromises()

    expect(wrapper.vm.state.mode).toBe('keyword')
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.objectContaining({ query: 'onboarding' })
      })
    )
  })

  it('preserves the current mode on a route-query change carrying no mode param at all', async () => {
    const { wrapper, router } = await mountSearchWithMode({
      semanticEnabled: true,
      initialPath: '/_search?q=onboarding&mode=semantic',
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    expect(wrapper.vm.state.mode).toBe('semantic')

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE], totalHits: 1, suggestion: null })
    })
    await router.push({ path: '/_search', query: { q: 'onboarding tag' } })
    await flushPromises()

    expect(wrapper.vm.state.mode).toBe('semantic')
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.objectContaining({ query: 'onboarding tag' })
      })
    )
  })
})

/**
 * OpenProject #3106: the hop-2 "related via" indicator. `SearchResultHopBadge.test.js` owns the
 * badge's own draw/no-draw rules across every `hop` value; this only confirms `Search.vue` threads a
 * result's `hop` field through to the row that renders it, with no re-derivation of its own.
 */
function createSearchI18nWithHop() {
  return createTestI18n({
    search: {
      results: 'Search Results',
      emptyQuery: 'Enter a query in the search field above and press Enter.',
      totalResults: 'No result | {0} result | {0} results',
      totalResultsApprox: 'No result | At least {0} result | At least {0} results',
      loadMore: 'Load More',
      relatedResult: 'Related',
      relatedResultHint: 'This result did not match your search directly.'
    }
  })
}

async function mountSearchWithHopResponse(searchResponse) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(searchResponse) })

  const router = await createSearchRouter('/_search?q=onboarding')
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createSearchI18nWithHop()],
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  activeWrapper = wrapper
  await flushPromises()
  return { wrapper }
}

describe('Search.vue hop-2 "related via" indicator (OpenProject #3106)', () => {
  it('shows the badge on a hop-2 row and not on a hop-1 row beside it', async () => {
    const { wrapper } = await mountSearchWithHopResponse({
      results: [
        { ...FIXTURE_RICH_RESULT, hop: 1 },
        { ...FIXTURE_RICH_RESULT, id: 'p11', path: 'other-page', title: 'Other Page', hop: 2 }
      ],
      totalHits: 2,
      totalHitsApproximate: false,
      suggestion: null
    })

    const [hop1Row, hop2Row] = wrapper.findAll('.layout-search-row')
    expect(hop1Row.find('.search-result-hop-badge').exists()).toBe(false)
    expect(hop2Row.find('.search-result-hop-badge').exists()).toBe(true)
    expect(hop2Row.text()).toContain('Related')
  })

  it('shows no badge at all for a keyword-mode result, which carries no hop field', async () => {
    const { wrapper } = await mountSearchWithHopResponse({
      results: [FIXTURE_RICH_RESULT],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    expect(wrapper.find('.search-result-hop-badge').exists()).toBe(false)
  })
})

/**
 * OpenProject #3223: the semantic-mode similarity match badge.
 * `SearchResultSimilarityBadge.test.js` owns the badge's own draw/no-draw and rounding rules across
 * every `distance` value; this only confirms `Search.vue` threads a result's `distance` field through
 * to the row that renders it, with no re-derivation of its own.
 */
function createSearchI18nWithSimilarity() {
  return createTestI18n({
    search: {
      results: 'Search Results',
      emptyQuery: 'Enter a query in the search field above and press Enter.',
      totalResults: 'No result | {0} result | {0} results',
      totalResultsApprox: 'No result | At least {0} result | At least {0} results',
      loadMore: 'Load More',
      similarityMatch: '{percent}% match'
    }
  })
}

async function mountSearchWithSimilarityResponse(searchResponse) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(searchResponse) })

  const router = await createSearchRouter('/_search?q=onboarding')
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createSearchI18nWithSimilarity()],
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  activeWrapper = wrapper
  await flushPromises()
  return { wrapper }
}

describe('Search.vue similarity match badge (OpenProject #3223)', () => {
  it('shows a rounded percentage badge for a semantic-mode result carrying distance', async () => {
    const { wrapper } = await mountSearchWithSimilarityResponse({
      results: [{ ...FIXTURE_RICH_RESULT, distance: 0.13, hop: 1 }],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    const badge = wrapper.find('.search-result-similarity-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('87% match')
  })

  it('shows no badge at all for a keyword-mode result, which carries no distance field', async () => {
    const { wrapper } = await mountSearchWithSimilarityResponse({
      results: [FIXTURE_RICH_RESULT],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    expect(wrapper.find('.search-result-similarity-badge').exists()).toBe(false)
  })

  /*
    OpenProject #3293: the badge used to sit on the title line, wrapping with `item.title` inside
    `.layout-search-rowtitle`, with an icon and a `w-chip` pill border. It now lives in the top-right
    meta column, as plain text, in the date's own place.
  */
  it('renders the badge inside the top-right meta column, not on the title line', async () => {
    const { wrapper } = await mountSearchWithSimilarityResponse({
      results: [{ ...FIXTURE_RICH_RESULT, distance: 0.13, hop: 1 }],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    const title = wrapper.find('.layout-search-rowtitle')
    expect(title.find('.search-result-similarity-badge').exists()).toBe(false)
    expect(title.text()).not.toContain('match')

    const dateSlot = wrapper.find('.layout-search-rowdate')
    const badge = dateSlot.find('.search-result-similarity-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('87% match')
  })

  /*
    A semantic result carries no `updatedAt` at all (`SemanticSearchResult`'s wire schema has no such
    field), so the keyword-mode "no date" `'---'` fallback must not leak into the meta column behind
    the badge -- it should show only the match percentage, nothing else.
  */
  it('shows the match percentage rather than the "---" no-date placeholder for a semantic row', async () => {
    const { wrapper } = await mountSearchWithSimilarityResponse({
      results: [{ ...FIXTURE_RICH_RESULT, updatedAt: null, distance: 0.13, hop: 1 }],
      totalHits: 1,
      totalHitsApproximate: false,
      suggestion: null
    })

    expect(wrapper.find('.layout-search-rowdate').text()).toBe('87% match')
  })
})
