import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Index from './Index.vue'
import { closeProfilePopover, profilePopoverState } from '@/composables/profilePopover'
import { initials } from '@/helpers/initials'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'
import { createTestRouter } from '../../test/router.js'

/*
  `useMinWidth` (via `useScreen`) calls `window.matchMedia`, and the common store reads
  `localStorage` the moment it is instantiated -- both needed by any full page-view mount. Stubbed
  here rather than in the shared `test/setup.js`, which would be a bigger claim about every future
  test than this one warrants.
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

/** Names chosen so that no two watchers draw the same two letters. */
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
 * The page is seeded onto the store AFTER the mount has settled rather than through `mountWithApp`'s
 * own seeding, because this view's route watcher runs `pageLoad` immediately and that request is not
 * what these tests stub: left to race, its failure blanks the very page id they just seeded. Seeding
 * once it has already failed is what makes the watchers fetch the only request in flight.
 */
async function mountIndex({ payload, sidebar = true } = {}) {
  const api = stubApi({ [WATCHERS_URL]: payload })

  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore, userStore } = mountWithApp(Index, {
    router,
    messages: {
      common: { page: { watching: 'Watching', watchingMore: '{count} more' } },
      profilePopover: { avatarLabel: 'Open the profile of {name}' }
    },
    global: {
      stubs: {
        PageHeader: true,
        PageActionsCol: true,
        PageToc: true,
        PageTags: true,
        SideDialog: true,
        PageRedirect: true,
        FooterNav: true,
        PageComments: true,
        PageCommentsEmbed: true
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

  return { wrapper, pageStore, siteStore, userStore, api }
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

  /**
   * `pageStore.isWatching` flips synchronously, well before the PUT it kicks off has resolved, so a
   * re-fetch keyed on it reads back the state from before the click. Driving the real
   * `pageStore.pageWatch()` with a deferred PUT is what exercises the ordering: no GET until the
   * write resolves.
   */
  it('re-fetches the watchers only after the write resolves, not on the optimistic isWatching flip', async () => {
    let answer = { watchers: [], total: 0 }
    const { wrapper, pageStore, api } = await mountIndex({ payload: () => answer })
    expect(wrapper.find('.page-watchers').exists()).toBe(false)
    const callsBeforeToggle = api.calls.length

    let resolvePut
    globalThis.API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolvePut = resolve
        })
    })

    const pending = pageStore.pageWatch(true)
    await settle(wrapper)

    expect(pageStore.isWatching).toBe(true)
    expect(api.calls.length).toBe(callsBeforeToggle)
    expect(plates(wrapper)).toHaveLength(0)

    answer = { watchers: makeWatchers(1), total: 1 }
    resolvePut({ ok: true, isWatching: true })
    await pending
    await settle(wrapper)

    expect(api.calls.length).toBeGreaterThan(callsBeforeToggle)
    expect(plates(wrapper)).toHaveLength(1)
  })

  /**
   * The route returns only the oldest `WATCHER_PLATE_CAP` watchers, so on a page that already has
   * that many the reader's own, freshly-added row -- always the newest -- falls outside the slice
   * entirely. The rail must show it anyway whenever the reader is watching, never a "watching" bell
   * beside a plate row they are absent from.
   */
  it("pins the reader's own plate first even when the fetch's oldest-N slice would drop them", async () => {
    const { wrapper, pageStore, userStore } = await mountIndex({
      payload: { watchers: makeWatchers(3), total: 4 }
    })
    expect(plates(wrapper)).toHaveLength(3)

    userStore.authenticated = true
    userStore.id = 'self-id'
    userStore.name = 'Self Reader'
    pageStore.isWatching = true
    await settle(wrapper)

    const rows = plates(wrapper)
    expect(rows).toHaveLength(3)
    expect(rows[0].attributes('title')).toBe('Self Reader')
    // -> +1, not +0: pinning the reader in did not shrink how many watchers still go uncounted.
    expect(wrapper.find('.page-watchers-remainder').text()).toBe('+1')
  })

  it('does not pin a plate for a guest, who cannot watch a page at all', async () => {
    const { wrapper, pageStore, userStore } = await mountIndex({
      payload: { watchers: makeWatchers(3), total: 3 }
    })
    userStore.authenticated = false
    pageStore.isWatching = false
    await settle(wrapper)

    expect(plates(wrapper).map((plate) => plate.attributes('title'))).toEqual([
      'Dylan Hart',
      'Mira Rossi',
      'Sam Okonkwo'
    ])
  })

  it('does not ask at all while the rail itself is switched off', async () => {
    const { api } = await mountIndex({
      payload: { watchers: makeWatchers(3), total: 3 },
      sidebar: false
    })

    expect(api.calls).not.toContain(WATCHERS_URL)
  })
})

describe('Index.vue: the rail Watching plates open the profile popover', () => {
  afterEach(() => {
    closeProfilePopover()
  })

  it('leaves the plates as plain, non-interactive boxes for a guest', async () => {
    const { wrapper } = await mountIndex({ payload: { watchers: makeWatchers(2), total: 2 } })

    const plate = plates(wrapper)[0]
    expect(plate.element.tagName).toBe('DIV')
    expect(plate.classes()).not.toContain('page-watchers-plate--button')

    await plate.trigger('click')
    expect(profilePopoverState.open).toBe(false)
  })

  it('draws real buttons for an account holder, keeping the full-name tooltip', async () => {
    const { wrapper, userStore } = await mountIndex({
      payload: { watchers: makeWatchers(2), total: 2 }
    })
    userStore.authenticated = true
    await settle(wrapper)

    const plate = plates(wrapper)[0]
    expect(plate.element.tagName).toBe('BUTTON')
    expect(plate.attributes('type')).toBe('button')
    expect(plate.attributes('title')).toBe('Dylan Hart')
    expect(plate.attributes('aria-label')).toBe('Open the profile of Dylan Hart')
    expect(plate.attributes('aria-haspopup')).toBe('dialog')
  })

  it('opens the popover for the clicked watcher, anchored to that plate', async () => {
    const { wrapper, userStore } = await mountIndex({
      payload: { watchers: makeWatchers(3), total: 3 }
    })
    userStore.authenticated = true
    await settle(wrapper)

    await plates(wrapper)[1].trigger('click')

    expect(profilePopoverState).toMatchObject({
      open: true,
      userId: 'user-2',
      name: 'Mira Rossi'
    })
    expect(profilePopoverState.anchor).toBe(plates(wrapper)[1].element)
  })

  it('makes the plates clickable for a guest once the instance allows it', async () => {
    const { wrapper, siteStore } = await mountIndex({
      payload: { watchers: makeWatchers(2), total: 2 }
    })
    siteStore.guestsMayViewProfiles = true
    await settle(wrapper)

    expect(plates(wrapper)[0].element.tagName).toBe('BUTTON')
  })
})
