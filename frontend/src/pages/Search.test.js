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

/** The regex `extractTags()` replaces, kept as a differential-test oracle. */
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
    // Deliberately NOT differential-tested against `legacyExtractTags`: this shape is the
    // quadratic-backtracking case, so the old regex would hang here.
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

/* `useMinWidth` (via `useScreen`) calls `window.matchMedia`, which happy-dom may not supply. */
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
 * `state.results` is replaced wholesale on any filter change (the `deep: true` watcher on
 * `state.params`). Without a `:key` on each result row, Vue patches rows by index instead of
 * identity, reusing a row's DOM element -- and the state it holds: focus, scroll position,
 * in-flight transitions -- across two unrelated results.
 */
describe('Search.vue results list keying (WP #1728)', () => {
  it('replaces a row DOM element (does not reuse it) when the result set changes to unrelated results', async () => {
    const { wrapper } = await mountSearch()

    wrapper.vm.state.results = [
      resultItem('en', 'page-one', 'Page One'),
      resultItem('en', 'page-two', 'Page Two')
    ]
    await flushPromises()

    // -> The href carries no locale prefix: `siteStore.localeRouting.useLocales` defaults falsy.
    const firstRowBefore = wrapper.find('a[href="/page-one"]')
    expect(firstRowBefore.exists()).toBe(true)
    const firstElBefore = firstRowBefore.element

    // -> No keys in common with the first set, same length and same index-0 position: the shape
    //    index-patching would silently survive.
    wrapper.vm.state.results = [
      resultItem('en', 'page-three', 'Page Three'),
      resultItem('en', 'page-four', 'Page Four')
    ]
    await flushPromises()

    const firstRowAfter = wrapper.find('a[href="/page-three"]')
    expect(firstRowAfter.exists()).toBe(true)
    expect(firstRowAfter.element).not.toBe(firstElBefore)

    expect(wrapper.find('a[href="/page-one"]').exists()).toBe(false)
  })
})

describe('Search.vue empty-query prompt (OpenProject #2984)', () => {
  it('renders the empty-query prompt in its own italic type role when no search has run', async () => {
    const { wrapper } = await mountSearch()

    const prompt = wrapper.find('.layout-search-empty-prompt')
    expect(prompt.exists()).toBe(true)
    expect(prompt.find('em').exists()).toBe(true)
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

/** Real messages, not an empty stub: the wording these keys produce is itself under test. */
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
      modeToggleLabel: 'Search Mode',
      addFilter: 'Add filter',
      removeFilter: 'Remove filter',
      filtersActive: 'Filters ({count})'
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
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  activeWrapper = wrapper
  await flushPromises()
  return { wrapper, siteStore, userStore, i18n }
}

/** `firstResponse` has to be queued before mount: the `route.query` watcher fires immediately. */
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
      // -> HeaderNav pulls in HeaderSearch, whose onMounted() focuses its search field whenever
      //    the route starts with `/_search`, which throws under happy-dom with nothing to focus.
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

/** `features.semanticSearch` has to be set before the component's `onMounted()` reads it. */
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
        searchParams: expect.arrayContaining([['offset', 0]])
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
        searchParams: expect.arrayContaining([['offset', 2]])
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
        searchParams: expect.arrayContaining([['offset', 0]])
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1'])
    expect(wrapper.vm.state.offset).toBe(1)
  })
})

/**
 * Vue passes `(newValue, oldValue, onCleanup)` to a watch callback, so wiring `performSearch`
 * straight into `watch(() => state.params, debounce(performSearch, 500), { deep: true })` makes
 * its `append` parameter truthy: `runSearchRequest` then reuses the stale `state.offset` and every
 * filter change requests a page past the end of the results.
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
        searchParams: expect.arrayContaining([['offset', 0]])
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1'])
  })

  it('re-searches from offset 0 when a filter row changes, not just the sort order', async () => {
    const { wrapper } = await mountSearchWithOffset('/_search?q=test', {
      results: [FIXTURE_PAGE_A, FIXTURE_PAGE_B],
      totalHits: 2,
      suggestion: null
    })
    expect(wrapper.vm.state.offset).toBe(2)

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [FIXTURE_PAGE_A], totalHits: 2, suggestion: null })
    })

    wrapper.vm.state.filters = [
      { id: 1, mode: 'include', type: 'publishState', value: 'published' }
    ]
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({
        searchParams: expect.arrayContaining([['offset', 0]])
      })
    )
  })
})

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

    expect(wrapper.find('.layout-search-back').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('circle-arrow-left')
    // -> `<script setup>` bindings are exposed on the instance, so a surviving `goBack` would be a
    //    function here rather than `undefined`.
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
      `FIXTURE_RICH_RESULT.updatedAt` sits well beyond `formatRecent`'s 7-day window, so this
      asserts against `formatRecent`'s own fallback output rather than a hand-written absolute
      string.
    */
    expect(row.find('.layout-search-rowdate').text()).toBe(
      userStore.formatRecent(i18n.global.t, FIXTURE_RICH_RESULT.updatedAt)
    )

    const excerpt = row.find('.layout-search-rowexcerpt')
    expect(excerpt.classes()).toContain('text-highlight')
    expect(excerpt.find('b').text()).toBe('credentials')
  })

  /*
    `chunkText` (the matched embedding chunk) is raw stored content, not pre-escaped highlight
    markup, so it renders as plain text rather than through `v-html`.
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

    expect(siteStore.search).toBe('onboarding')
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.arrayContaining([
          ['query', 'onboarding'],
          ['offset', 0]
        ])
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
        searchParams: expect.arrayContaining([
          ['query', 'onboarding'],
          ['offset', 0]
        ])
      })
    )
    expect(wrapper.vm.state.results.map((r) => r.id)).toEqual(['p1'])
  })

  it('sends each locale row as its own repeated locales pair in Semantic mode', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    wrapper.vm.state.filters = [
      { id: 1, mode: 'include', type: 'locale', value: 'en' },
      { id: 2, mode: 'include', type: 'locale', value: 'fr' }
    ]

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.arrayContaining([
          ['locales', 'en'],
          ['locales', 'fr']
        ])
      })
    )
    expect(pairNames(lastSearchParams())).not.toContain('excludeLocales')
  })

  it('sends every include and exclude row under the list-valued contract names in Semantic mode', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })
    wrapper.vm.state.filters = [
      { id: 1, mode: 'include', type: 'path', value: 'docs' },
      { id: 2, mode: 'exclude', type: 'path', value: 'docs/archive' },
      { id: 3, mode: 'include', type: 'tag', value: 'alpha' },
      { id: 4, mode: 'exclude', type: 'tag', value: 'beta' },
      { id: 5, mode: 'exclude', type: 'locale', value: 'fr' },
      { id: 6, mode: 'include', type: 'editor', value: 'markdown' },
      { id: 7, mode: 'exclude', type: 'editor', value: 'asciidoc' },
      { id: 8, mode: 'include', type: 'publishState', value: 'published' },
      { id: 9, mode: 'exclude', type: 'publishState', value: 'draft' }
    ]

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'sites/site-1/pages/search/semantic',
      expect.objectContaining({
        searchParams: expect.arrayContaining([
          ['path', 'docs'],
          ['excludePath', 'docs/archive'],
          ['tags', 'alpha'],
          ['excludeTags', 'beta'],
          ['excludeLocales', 'fr'],
          ['editor', 'markdown'],
          ['excludeEditor', 'asciidoc'],
          ['publishState', 'published'],
          ['excludePublishState', 'draft']
        ])
      })
    )
  })

  it('omits every filter param from the semantic request when there are no rows', async () => {
    const { wrapper } = await mountSearchWithMode({
      semanticEnabled: true,
      firstResponse: { results: [FIXTURE_PAGE], totalHits: 1, suggestion: null }
    })

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: null })
    })
    wrapper.vm.setSearchMode('semantic')
    await flushPromises()

    expect(pairNames(lastSearchParams()).sort()).toEqual(['limit', 'offset', 'query'])
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

    expect(wrapper.find('.layout-search-sd').attributes('style') ?? '').not.toContain(
      'display: none'
    )
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
 * `HeaderSearch.vue` carries its pending mode as a `mode` query param on the navigation to
 * `/_search`, so a semantic search started from the header has to land here already in Semantic
 * mode rather than requiring a second click.
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
        searchParams: expect.arrayContaining([['query', 'onboarding']])
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
        searchParams: expect.arrayContaining([['query', 'onboarding']])
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
        searchParams: expect.arrayContaining([['query', 'onboarding']])
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
        searchParams: expect.arrayContaining([['query', 'onboarding tag']])
      })
    )
  })
})

/**
 * `SearchResultHopBadge.test.js` owns the badge's own draw/no-draw rules across every `hop` value;
 * this only confirms `Search.vue` threads a result's `hop` through to the row that renders it.
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
 * `SearchResultSimilarityBadge.test.js` owns the badge's own draw/no-draw and rounding rules across
 * every `distance` value; this only confirms `Search.vue` threads a result's `distance` through to
 * the row that renders it.
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
    A semantic result carries no `updatedAt` (`SemanticSearchResult`'s wire schema has no such
    field), so the keyword-mode `'---'` fallback must not leak into the meta column behind the badge.
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

function lastSearchParams() {
  return API_CLIENT.get.mock.calls.at(-1)[1].searchParams
}

function pairNames(pairs) {
  return pairs.map(([name]) => name)
}

function searchCalls() {
  return API_CLIENT.get.mock.calls.filter(([url]) => url.startsWith('sites/site-1/pages/search'))
}

/**
 * `profile` is what `users/profile` answers (or a rejection for `'fail'`); anything else is a
 * search. Queued before mount because the route watcher and `onMounted` both fire during it.
 */
async function mountWithFilters({
  authenticated = false,
  profile = { searchFilters: [] },
  initialPath = '/_search?q=onboarding',
  activeLocales
} = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  const userStore = useUserStore()
  userStore.authenticated = authenticated
  if (activeLocales) {
    siteStore.locales.active = activeLocales.map((code) => ({ code, name: code.toUpperCase() }))
  }

  API_CLIENT.get.mockImplementation((url) => ({
    json: () => {
      if (url === 'users/profile') {
        return profile === 'fail' ? Promise.reject(new Error('down')) : Promise.resolve(profile)
      }
      return Promise.resolve({ results: [FIXTURE_PAGE], totalHits: 1, suggestion: null })
    }
  }))
  API_CLIENT.put.mockImplementation(() => ({ json: () => Promise.resolve({ ok: true }) }))

  const router = await createSearchRouter(initialPath)
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createSearchI18n()],
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  activeWrapper = wrapper
  await flushPromises()
  return { wrapper, siteStore, userStore }
}

function rows(wrapper) {
  return wrapper.findAll('[data-testid="search-filter-row"]')
}

describe('Search.vue dynamic filter rows (OpenProject #3518)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no rows and sends no filter param on the first search', async () => {
    const { wrapper } = await mountWithFilters()

    expect(rows(wrapper)).toHaveLength(0)
    expect(pairNames(lastSearchParams()).sort()).toEqual([
      'limit',
      'offset',
      'orderBy',
      'orderByDirection',
      'query'
    ])
  })

  it('draws an add button in the Filters header carrying the plus glyph', async () => {
    const { wrapper } = await mountWithFilters()

    const add = wrapper.find('[data-testid="search-filter-add"]')
    expect(add.exists()).toBe(true)
    expect(add.attributes('aria-label')).toBe('Add filter')
    const filtersHeader = wrapper
      .findAll('.section-header')
      .find((el) => el.text() === 'search.filters')
    expect(filtersHeader.find('[data-testid="search-filter-add"]').exists()).toBe(true)
  })

  it('adds an Include/Path row with an empty value, and no request for a blank row', async () => {
    const { wrapper } = await mountWithFilters()
    API_CLIENT.get.mockClear()

    await wrapper.find('[data-testid="search-filter-add"]').trigger('click')
    await vi.advanceTimersByTimeAsync(600)
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.vm.state.filters).toMatchObject([{ mode: 'include', type: 'path', value: '' }])
    expect(searchCalls()).toHaveLength(0)
  })

  it('gives every row a trash button named "Remove filter" that is always present', async () => {
    const { wrapper } = await mountWithFilters()
    await wrapper.find('[data-testid="search-filter-add"]').trigger('click')

    const remove = rows(wrapper)[0].find('[data-testid="search-filter-remove"]')
    expect(remove.exists()).toBe(true)
    expect(remove.attributes('aria-label')).toBe('Remove filter')
  })

  it('draws a text input for path and tag rows, and a dropdown for the other three types', async () => {
    const { wrapper } = await mountWithFilters()
    await wrapper.find('[data-testid="search-filter-add"]').trigger('click')
    const [row] = wrapper.vm.state.filters

    const valueEl = () => rows(wrapper)[0].find('[data-testid="search-filter-value"]')
    expect(valueEl().element.tagName).toBe('INPUT')
    expect(valueEl().attributes('role')).toBeUndefined()

    wrapper.vm.setFilterType(row, 'tag')
    await flushPromises()
    expect(valueEl().element.tagName).toBe('INPUT')

    for (const type of ['locale', 'editor', 'publishState']) {
      wrapper.vm.setFilterType(row, type)
      await flushPromises()
      expect(valueEl().attributes('role')).toBe('combobox')
    }
  })

  it('starts a Locale row at the only active locale when the site has just one', async () => {
    const { wrapper } = await mountWithFilters()
    await wrapper.find('[data-testid="search-filter-add"]').trigger('click')

    wrapper.vm.setFilterType(wrapper.vm.state.filters[0], 'locale')

    expect(wrapper.vm.state.filters[0].value).toBe('en')
  })

  it('leaves a Locale row unset when the site has several locales', async () => {
    const { wrapper } = await mountWithFilters({ activeLocales: ['en', 'fr'] })
    await wrapper.find('[data-testid="search-filter-add"]').trigger('click')

    wrapper.vm.setFilterType(wrapper.vm.state.filters[0], 'locale')

    expect(wrapper.vm.state.filters[0].value).toBe('')
  })

  it('starts a Publish State row at Published, and an Editor row unset', async () => {
    const { wrapper } = await mountWithFilters()
    await wrapper.find('[data-testid="search-filter-add"]').trigger('click')
    const [row] = wrapper.vm.state.filters

    wrapper.vm.setFilterType(row, 'publishState')
    expect(row.value).toBe('published')

    wrapper.vm.setFilterType(row, 'editor')
    expect(row.value).toBe('')
  })

  it('keeps the typed text when a row switches between path and tag', async () => {
    const { wrapper } = await mountWithFilters()
    await wrapper.find('[data-testid="search-filter-add"]').trigger('click')
    const [row] = wrapper.vm.state.filters
    wrapper.vm.setFilterValue(row, 'docs')

    wrapper.vm.setFilterType(row, 'tag')

    expect(row.value).toBe('docs')
  })

  it('stops adding rows at the 20 the preference accepts', async () => {
    const { wrapper } = await mountWithFilters()
    for (let i = 0; i < 25; i++) {
      wrapper.vm.addFilter()
    }
    await flushPromises()

    expect(wrapper.vm.state.filters).toHaveLength(20)
    expect(wrapper.find('[data-testid="search-filter-add"]').attributes('disabled')).toBeDefined()
  })

  it('re-searches with a repeated pair per row once a path value is typed', async () => {
    const { wrapper } = await mountWithFilters()
    await wrapper.find('[data-testid="search-filter-add"]').trigger('click')
    API_CLIENT.get.mockClear()

    await rows(wrapper)[0].find('input[data-testid="search-filter-value"]').setValue('/docs')
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(searchCalls()).toHaveLength(1)
    expect(lastSearchParams()).toEqual(
      expect.arrayContaining([
        ['query', 'onboarding'],
        ['path', 'docs']
      ])
    )
  })

  it('sends an Exclude row under the exclude* name', async () => {
    const { wrapper } = await mountWithFilters()
    wrapper.vm.state.filters = [{ id: 1, mode: 'exclude', type: 'path', value: 'private' }]
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(lastSearchParams()).toEqual(expect.arrayContaining([['excludePath', 'private']]))
    expect(pairNames(lastSearchParams())).not.toContain('path')
  })

  it('repeats a name once per row rather than joining values, so enum lists stay valid', async () => {
    const { wrapper } = await mountWithFilters()
    wrapper.vm.state.filters = [
      { id: 1, mode: 'include', type: 'publishState', value: 'draft' },
      { id: 2, mode: 'include', type: 'publishState', value: 'published' },
      { id: 3, mode: 'include', type: 'locale', value: 'en' },
      { id: 4, mode: 'include', type: 'locale', value: 'fr' }
    ]
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    const pairs = lastSearchParams()
    expect(pairs.filter(([name]) => name === 'publishState')).toEqual([
      ['publishState', 'draft'],
      ['publishState', 'published']
    ])
    expect(pairs.filter(([name]) => name === 'locales')).toEqual([
      ['locales', 'en'],
      ['locales', 'fr']
    ])
    expect(pairs.every(([, value]) => !String(value).includes(','))).toBe(true)
  })

  it('serializes to a query string that repeats each key', async () => {
    const { wrapper } = await mountWithFilters()
    wrapper.vm.state.filters = [
      { id: 1, mode: 'include', type: 'tag', value: 'a' },
      { id: 2, mode: 'include', type: 'tag', value: 'b' },
      { id: 3, mode: 'exclude', type: 'tag', value: 'c' }
    ]
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    const query = new URLSearchParams(lastSearchParams())
    expect(query.getAll('tags')).toEqual(['a', 'b'])
    expect(query.getAll('excludeTags')).toEqual(['c'])
  })

  it('merges #tags typed in the query with tag rows without duplicating one', async () => {
    const { wrapper } = await mountWithFilters({ initialPath: '/_search?q=onboarding%20%23alpha' })
    wrapper.vm.state.filters = [
      { id: 1, mode: 'include', type: 'tag', value: 'alpha' },
      { id: 2, mode: 'include', type: 'tag', value: 'beta' }
    ]
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(lastSearchParams().filter(([name]) => name === 'tags')).toEqual([
      ['tags', 'alpha'],
      ['tags', 'beta']
    ])
    expect(lastSearchParams()).toEqual(expect.arrayContaining([['query', 'onboarding']]))
  })

  it('removes a row and re-searches without it', async () => {
    const { wrapper } = await mountWithFilters()
    wrapper.vm.state.filters = [
      { id: 1, mode: 'include', type: 'path', value: 'docs' },
      { id: 2, mode: 'include', type: 'tag', value: 'alpha' }
    ]
    await flushPromises()
    API_CLIENT.get.mockClear()

    await rows(wrapper)[0].find('[data-testid="search-filter-remove"]').trigger('click')
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()

    expect(wrapper.vm.state.filters.map((r) => r.id)).toEqual([2])
    expect(pairNames(lastSearchParams())).not.toContain('path')
    expect(lastSearchParams()).toEqual(expect.arrayContaining([['tags', 'alpha']]))
  })

  describe('the filters-only-search guard', () => {
    it('runs a search with no query text when an include row applies', async () => {
      const { wrapper } = await mountWithFilters({ initialPath: '/_search' })
      API_CLIENT.get.mockClear()

      wrapper.vm.state.filters = [{ id: 1, mode: 'include', type: 'publishState', value: 'draft' }]
      await vi.advanceTimersByTimeAsync(500)
      await flushPromises()

      expect(searchCalls()).toHaveLength(1)
      expect(pairNames(lastSearchParams())).not.toContain('query')
      expect(lastSearchParams()).toEqual(expect.arrayContaining([['publishState', 'draft']]))
    })

    it('does not list the wiki for exclude rows alone with no query text', async () => {
      const { wrapper } = await mountWithFilters({ initialPath: '/_search' })
      API_CLIENT.get.mockClear()

      wrapper.vm.state.filters = [{ id: 1, mode: 'exclude', type: 'path', value: 'private' }]
      await vi.advanceTimersByTimeAsync(500)
      await flushPromises()

      expect(searchCalls()).toHaveLength(0)
      expect(wrapper.vm.state.results).toEqual([])
    })

    it('does not search for an include row whose value is still blank', async () => {
      const { wrapper } = await mountWithFilters({ initialPath: '/_search' })
      API_CLIENT.get.mockClear()

      wrapper.vm.state.filters = [{ id: 1, mode: 'include', type: 'path', value: '   ' }]
      await vi.advanceTimersByTimeAsync(500)
      await flushPromises()

      expect(searchCalls()).toHaveLength(0)
    })
  })

  describe('the mobile Filters disclosure label', () => {
    it('is the plain label when no filter applies', async () => {
      const { wrapper } = await mountWithFilters()

      expect(wrapper.vm.filtersButtonLabel).toBe('search.filters')
    })

    it('carries how many filters apply, ignoring blank rows', async () => {
      const { wrapper } = await mountWithFilters()
      wrapper.vm.state.filters = [
        { id: 1, mode: 'include', type: 'path', value: 'docs' },
        { id: 2, mode: 'exclude', type: 'tag', value: 'old' },
        { id: 3, mode: 'include', type: 'path', value: '' }
      ]
      await flushPromises()

      expect(wrapper.vm.filtersButtonLabel).toBe('Filters (2)')
    })
  })

  describe('the searchFilters preference', () => {
    it('keeps an anonymous reader session-only: nothing is read or written', async () => {
      const { wrapper } = await mountWithFilters({ authenticated: false })
      wrapper.vm.addFilter()
      wrapper.vm.setFilterValue(wrapper.vm.state.filters[0], 'docs')
      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()

      expect(API_CLIENT.get).not.toHaveBeenCalledWith('users/profile')
      expect(API_CLIENT.put).not.toHaveBeenCalled()
    })

    it('loads the saved rows and searches once with them, never once without', async () => {
      const { wrapper } = await mountWithFilters({
        authenticated: true,
        profile: {
          searchFilters: [
            { mode: 'exclude', type: 'path', value: 'private' },
            { mode: 'include', type: 'locale', value: 'en' }
          ]
        }
      })
      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()

      expect(wrapper.vm.state.filters).toMatchObject([
        { mode: 'exclude', type: 'path', value: 'private' },
        { mode: 'include', type: 'locale', value: 'en' }
      ])
      expect(rows(wrapper)).toHaveLength(2)
      expect(searchCalls()).toHaveLength(1)
      expect(lastSearchParams()).toEqual(
        expect.arrayContaining([
          ['excludePath', 'private'],
          ['locales', 'en']
        ])
      )
    })

    it('searches unfiltered once when the reader has nothing saved', async () => {
      await mountWithFilters({ authenticated: true, profile: {} })
      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()

      expect(searchCalls()).toHaveLength(1)
    })

    it('drops a stored row this build does not understand instead of sending it', async () => {
      const { wrapper } = await mountWithFilters({
        authenticated: true,
        profile: {
          searchFilters: [
            { mode: 'include', type: 'author', value: 'x' },
            { mode: 'include', type: 'publishState', value: 'archived' },
            { mode: 'exclude', type: 'tag', value: 'old' }
          ]
        }
      })

      expect(wrapper.vm.state.filters).toMatchObject([
        { mode: 'exclude', type: 'tag', value: 'old' }
      ])
    })

    it('still searches, unfiltered, when the profile cannot be read', async () => {
      const { wrapper } = await mountWithFilters({ authenticated: true, profile: 'fail' })
      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()

      expect(wrapper.vm.state.filters).toEqual([])
      expect(searchCalls()).toHaveLength(1)
    })

    it('saves only the applied rows, in the frozen {mode, type, value} shape, after a pause', async () => {
      const { wrapper } = await mountWithFilters({ authenticated: true })
      await vi.advanceTimersByTimeAsync(1000)
      wrapper.vm.addFilter()
      wrapper.vm.addFilter()
      const [first, second] = wrapper.vm.state.filters
      wrapper.vm.setFilterValue(first, ' docs ')
      wrapper.vm.setFilterMode(second, 'exclude')
      await vi.advanceTimersByTimeAsync(499)
      expect(API_CLIENT.put).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await flushPromises()

      expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
      expect(API_CLIENT.put).toHaveBeenCalledWith('users/profile', {
        json: { searchFilters: [{ mode: 'include', type: 'path', value: 'docs' }] }
      })
    })

    it('saves an empty list when the last row is removed', async () => {
      const { wrapper } = await mountWithFilters({
        authenticated: true,
        profile: { searchFilters: [{ mode: 'include', type: 'tag', value: 'alpha' }] }
      })
      await vi.advanceTimersByTimeAsync(1000)

      wrapper.vm.removeFilter(wrapper.vm.state.filters[0])
      await vi.advanceTimersByTimeAsync(500)
      await flushPromises()

      expect(API_CLIENT.put).toHaveBeenCalledWith('users/profile', {
        json: { searchFilters: [] }
      })
    })

    it('does not write back what it just loaded', async () => {
      await mountWithFilters({
        authenticated: true,
        profile: { searchFilters: [{ mode: 'include', type: 'tag', value: 'alpha' }] }
      })
      await vi.advanceTimersByTimeAsync(2000)
      await flushPromises()

      expect(API_CLIENT.put).not.toHaveBeenCalled()
    })

    it('flushes a pending save when the page is left', async () => {
      const { wrapper } = await mountWithFilters({ authenticated: true })
      await vi.advanceTimersByTimeAsync(1000)
      wrapper.vm.addFilter()
      wrapper.vm.setFilterValue(wrapper.vm.state.filters[0], 'docs')

      wrapper.unmount()
      activeWrapper = null
      await flushPromises()

      expect(API_CLIENT.put).toHaveBeenCalledWith('users/profile', {
        json: { searchFilters: [{ mode: 'include', type: 'path', value: 'docs' }] }
      })
    })

    it('never sends an anonymous session a save, even after edits', async () => {
      const { wrapper } = await mountWithFilters({ authenticated: false })
      wrapper.vm.addFilter()
      wrapper.vm.setFilterValue(wrapper.vm.state.filters[0], 'docs')
      wrapper.unmount()
      activeWrapper = null
      await flushPromises()

      expect(API_CLIENT.put).not.toHaveBeenCalled()
    })
  })
})
