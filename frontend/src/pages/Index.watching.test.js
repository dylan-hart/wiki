import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Index from './Index.vue'
import { initials } from '@/helpers/initials'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'
import { createTestRouter } from '../../test/router.js'

/**
 * OpenProject #2649 (Feature #2606): the Watching section of the page metadata rail.
 *
 * What the design draws is a run of at most three initial plates plus a `+N` remainder for everybody
 * past them; what the parent Feature settles is that the section is ABSENT -- heading and rule
 * included -- on a page nobody watches. Both are asserted here against the real `Index.vue`, mounted
 * through the shared harness with the watchers route stubbed, rather than against a stand-in: the
 * section's visibility is a computed off a fetch this view runs itself, and that fetch is the only
 * part of it worth faking.
 */

/*
  `useMinWidth` (via `useScreen`) calls `window.matchMedia`, and the common store reads
  `localStorage` the moment it is instantiated -- both needed by any full page-view mount, and both
  stubbed locally here for the reason `Index.view.test.js` states rather than in the shared
  `test/setup.js`, which would be a bigger claim about every future test than this one warrants.
*/
beforeEach(() => {
  window.matchMedia =
    window.matchMedia ??
    vi.fn().mockImplementation((query) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))

  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  }
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

const SITE_ID = 'site-1'
const PAGE_ID = 'page-1'
const WATCHERS_URL = `sites/${SITE_ID}/pages/${PAGE_ID}/watchers`

/** Enough turns of the loop for a fetch to resolve and for the render it schedules to run. */
async function settle(wrapper) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

/** As many watchers as asked for, named so that no two draw the same two letters. */
function makeWatchers(count) {
  const names = [
    'Dylan Hart',
    'Mira Rossi',
    'Sam Okonkwo',
    'Ada Lovelace',
    'Grace Hopper',
    'Alan Turing',
    'Katherine Johnson'
  ]
  return Array.from({ length: count }, (_, index) => ({
    userId: `user-${index + 1}`,
    name: names[index],
    initials: initials(names[index]),
    watchedAt: '2026-09-01T10:00:00.000Z'
  }))
}

/**
 * Mounts the page view with the watchers route answering `payload`, then puts a page on screen.
 *
 * The page is seeded onto the store AFTER the mount has settled rather than through `mountWithApp`'s
 * own seeding, because this view's route watcher runs `pageLoad` immediately and that request is not
 * what these tests stub: left to race, its failure blanks the very page id they just seeded. Seeding
 * once it has already failed is what makes the watchers fetch the only request in flight.
 *
 * `sidebar: false` seeds a site with the rail switched off, for the one test that asserts nothing is
 * asked for at all in that case.
 */
async function mountIndex({ payload, sidebar = true } = {}) {
  const api = stubApi({ [WATCHERS_URL]: payload })

  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore } = mountWithApp(Index, {
    router,
    messages: { common: { page: { watching: 'Watching', watchingMore: '{count} more' } } },
    global: {
      stubs: {
        PageHeader: true,
        PageActionsCol: true,
        PageToc: true,
        PageTags: true,
        SideDialog: true,
        PageRedirect: true,
        FooterNav: true,
        PageComments: true
      }
    }
  })
  activeWrapper = wrapper

  await settle(wrapper)

  siteStore.id = SITE_ID
  siteStore.showSidebar = sidebar
  pageStore.notFound = false
  pageStore.id = PAGE_ID

  await settle(wrapper)

  return { wrapper, pageStore, siteStore, api }
}

function plates(wrapper) {
  return wrapper.findAll('.page-watchers-plate')
}

describe('Index.vue: the rail Watching section (OpenProject #2649)', () => {
  it('draws one plate per watcher, and no remainder, below the cap', async () => {
    const { wrapper } = await mountIndex({ payload: { watchers: makeWatchers(3), total: 3 } })

    expect(wrapper.find('.page-watchers').exists()).toBe(true)
    expect(plates(wrapper)).toHaveLength(3)
    expect(wrapper.find('.page-watchers-remainder').exists()).toBe(false)
  })

  it('caps the plates at three and reports everybody else as a remainder', async () => {
    const { wrapper } = await mountIndex({ payload: { watchers: makeWatchers(3), total: 7 } })

    expect(plates(wrapper)).toHaveLength(3)
    expect(wrapper.find('.page-watchers-remainder').text()).toBe('+4')
  })

  it('caps the plates at three even when the route hands back more than were asked for', async () => {
    const { wrapper } = await mountIndex({ payload: { watchers: makeWatchers(7), total: 7 } })

    expect(plates(wrapper)).toHaveLength(3)
    expect(wrapper.find('.page-watchers-remainder').text()).toBe('+4')
  })

  it('renders no section at all -- heading included -- on a page nobody watches', async () => {
    const { wrapper } = await mountIndex({ payload: { watchers: [], total: 0 } })

    expect(wrapper.find('.page-watchers').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Watching')
  })

  it('renders no section when the watchers request fails, rather than an error in the rail', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // -> A refusal from the route itself (a page this reader may not read answers 404), which is
    //    what a `stubApi` route whose value is a throwing function stands for.
    const { wrapper } = await mountIndex({
      payload: () => {
        throw new Error('refused')
      }
    })

    expect(wrapper.find('.page-watchers').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Watching')
    consoleWarn.mockRestore()
  })

  it('draws the two letters the server sent, and falls back to the shared helper without them', async () => {
    const { wrapper } = await mountIndex({
      payload: {
        watchers: [
          { userId: 'u1', name: 'Dylan James Hart', initials: 'DH' },
          { userId: 'u2', name: 'Ada Lovelace' },
          { userId: 'u3', name: '' }
        ],
        total: 3
      }
    })

    // -> `DH`, not `DJ`: the first and last word, the one rule `helpers/initials.js` keeps.
    expect(plates(wrapper).map((plate) => plate.text())).toEqual(['DH', 'AL', '?'])
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('')).toBe('?')
  })

  it('names each plate for a reader who cannot read two letters as a person', async () => {
    const { wrapper } = await mountIndex({ payload: { watchers: makeWatchers(1), total: 1 } })

    const plate = plates(wrapper)[0]
    expect(plate.attributes('title')).toBe('Dylan Hart')
    expect(plate.attributes('aria-label')).toBe('Dylan Hart')
  })

  it('asks the route for exactly as many watchers as it will draw', async () => {
    await mountIndex({ payload: { watchers: makeWatchers(3), total: 9 } })

    const call = globalThis.API_CLIENT.get.mock.calls.find(([url]) => url === WATCHERS_URL)
    expect(call).toBeTruthy()
    expect(call[1]).toEqual({ searchParams: { limit: 3 } })
  })

  it('asks again when the reader starts watching, so their own plate appears', async () => {
    const { wrapper, pageStore } = await mountIndex({ payload: { watchers: [], total: 0 } })
    expect(wrapper.find('.page-watchers').exists()).toBe(false)

    stubApi({ [WATCHERS_URL]: { watchers: makeWatchers(1), total: 1 } })
    pageStore.isWatching = true
    await settle(wrapper)

    expect(plates(wrapper)).toHaveLength(1)
  })

  it('does not ask at all while the rail itself is switched off', async () => {
    const { api } = await mountIndex({
      payload: { watchers: makeWatchers(3), total: 3 },
      sidebar: false
    })

    expect(api.calls).not.toContain(WATCHERS_URL)
  })
})
