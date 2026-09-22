import { describe, expect, it, vi } from 'vitest'

import InboxPages from './InboxPages.vue'

import { buildTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

const messages = {
  common: {
    loading: 'Loading...',
    actions: { refresh: 'Refresh' }
  },
  inbox: {
    pages: 'My Pages',
    pagesInfo: 'Your pages.',
    pagesContinue: 'Continue where you left off',
    pagesFavorites: 'Favorites',
    pagesPinned: 'Pinned',
    pagesRecent: 'Recent',
    pagesNone: 'Nothing yet.',
    pagesHint: 'Open a page.',
    pagesLoadFailed: 'Failed to load your pages.',
    pagesVisited: 'Last visited {date}'
  }
}

function entry(pageId, title, kind, extra = {}) {
  return {
    pageId,
    title,
    kind,
    path: `docs/${pageId}`,
    locale: 'en',
    icon: null,
    description: null,
    position: null,
    updatedAt: '2026-09-20T12:00:00.000Z',
    touchedAt: '2026-09-21T12:00:00.000Z',
    ...extra
  }
}

const LISTS = {
  recent: [entry('r1', 'Current Page', 'recent'), entry('r2', 'Previous Page', 'recent')],
  favorites: [entry('f1', 'Favorite Page', 'favorite')],
  pinned: [
    entry('p1', 'First Pin', 'pinned', { position: 0 }),
    entry('p2', 'Second Pin', 'pinned', { position: 1 })
  ]
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

async function mountInboxPages({ currentPageId = '' } = {}) {
  const router = buildTestRouter(['/', '/:path(.*)'])
  const result = mountWithApp(InboxPages, {
    messages,
    router,
    stores: {
      site: { id: 'site-1' },
      page: { id: currentPageId }
    }
  })
  await flush()
  return { ...result, router }
}

function titlesIn(wrapper, section) {
  return wrapper
    .find(`[data-test="pages-${section}"]`)
    .findAll('.w-item-label strong')
    .map((el) => el.text())
}

describe('InboxPages', () => {
  it('fetches sites/:siteId/user-pages on mount', async () => {
    stubApi({ 'sites/site-1/user-pages': LISTS })

    await mountInboxPages()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/user-pages')
  })

  it('renders pins, favorites and recents, pins in the order returned', async () => {
    stubApi({ 'sites/site-1/user-pages': LISTS })

    const { wrapper } = await mountInboxPages()

    expect(titlesIn(wrapper, 'pinned')).toEqual(['First Pin', 'Second Pin'])
    expect(titlesIn(wrapper, 'favorite')).toEqual(['Favorite Page'])
    expect(titlesIn(wrapper, 'recent')).toEqual(['Current Page', 'Previous Page'])

    const order = wrapper.findAll('section').map((el) => el.attributes('data-test'))
    expect(order).toEqual(['pages-pinned', 'pages-favorite', 'pages-recent'])
    expect(wrapper.find('[data-test="pages-empty"]').exists()).toBe(false)
  })

  it('leaves out a section with no entries', async () => {
    stubApi({ 'sites/site-1/user-pages': { ...LISTS, favorites: [], pinned: [] } })

    const { wrapper } = await mountInboxPages()

    expect(wrapper.find('[data-test="pages-pinned"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="pages-favorite"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="pages-recent"]').exists()).toBe(true)
  })

  it('shows the empty state, and no Continue link, when all three lists are empty', async () => {
    stubApi({ 'sites/site-1/user-pages': { recent: [], favorites: [], pinned: [] } })

    const { wrapper } = await mountInboxPages()

    expect(wrapper.find('[data-test="pages-empty"]').text()).toContain('Nothing yet.')
    expect(wrapper.find('[data-test="pages-continue"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="pages-error"]').exists()).toBe(false)
  })

  it('shows an error state distinct from the empty state when the fetch fails', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.reject(new Error('boom')) }))

    const { wrapper } = await mountInboxPages()

    expect(wrapper.find('[data-test="pages-error"]').text()).toContain('Failed to load your pages.')
    expect(wrapper.find('[data-test="pages-empty"]').exists()).toBe(false)
  })

  it('recovers from an error when Refresh succeeds', async () => {
    API_CLIENT.get.mockImplementationOnce(() => ({
      json: () => Promise.reject(new Error('boom'))
    }))
    stubApi({ 'sites/site-1/user-pages': LISTS })

    const { wrapper } = await mountInboxPages()
    expect(wrapper.find('[data-test="pages-error"]').exists()).toBe(true)

    await wrapper.find('[data-test="pages-error"] button').trigger('click')
    await flush()

    expect(wrapper.find('[data-test="pages-error"]').exists()).toBe(false)
    expect(titlesIn(wrapper, 'pinned')).toEqual(['First Pin', 'Second Pin'])
  })

  it('Continue links to the most recent page', async () => {
    stubApi({ 'sites/site-1/user-pages': LISTS })

    const { wrapper } = await mountInboxPages()

    const link = wrapper.find('[data-test="pages-continue"]')
    expect(link.text()).toContain('Continue where you left off')
    expect(link.text()).toContain('Current Page')
  })

  it('Continue skips the page the reader is already on', async () => {
    stubApi({ 'sites/site-1/user-pages': LISTS })

    const { wrapper } = await mountInboxPages({ currentPageId: 'r1' })

    const link = wrapper.find('[data-test="pages-continue"]')
    expect(link.text()).toContain('Previous Page')
    expect(link.text()).not.toContain('Current Page')
  })

  it('omits Continue when the only recent page is the current one', async () => {
    stubApi({
      'sites/site-1/user-pages': { ...LISTS, recent: [entry('r1', 'Current Page', 'recent')] }
    })

    const { wrapper } = await mountInboxPages({ currentPageId: 'r1' })

    expect(wrapper.find('[data-test="pages-continue"]').exists()).toBe(false)
  })

  it('opens a row: closes the overlay and navigates to the page', async () => {
    stubApi({ 'sites/site-1/user-pages': LISTS })

    const { wrapper, router, siteStore } = await mountInboxPages()
    siteStore.overlay = 'Inbox'
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('[data-test="pages-favorite"] .w-item').trigger('click')
    await flush()

    expect(siteStore.overlay).toBe('')
    expect(pushSpy).toHaveBeenCalledWith('/docs/f1')
  })

  it('Continue navigates to the page it names', async () => {
    stubApi({ 'sites/site-1/user-pages': LISTS })

    const { wrapper, router } = await mountInboxPages({ currentPageId: 'r1' })
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('[data-test="pages-continue"] .w-item').trigger('click')
    await flush()

    expect(pushSpy).toHaveBeenCalledWith('/docs/r2')
  })
})
