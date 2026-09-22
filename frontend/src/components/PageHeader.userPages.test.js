import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PageHeader from './PageHeader.vue'
import { useUserPagesStore } from '@/stores/userPages'
import { queue } from '@/composables/notify'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

async function mountHeader({ authenticated = true, page = {}, favorites = [], pinned = [] } = {}) {
  const router = await createTestRouter(['/'])
  API_CLIENT.get.mockImplementation(() => ({
    json: () =>
      Promise.resolve({
        recent: [],
        favorites: favorites.map((pageId) => ({ pageId })),
        pinned: pinned.map((pageId) => ({ pageId }))
      })
  }))
  const { wrapper } = mountWithApp(PageHeader, {
    router,
    stores: {
      user: (store) => {
        store.authenticated = authenticated
      },
      site: (store) => {
        store.id = 'site-1'
      },
      page: (store) => {
        store.$patch({ id: 'page-1', ...page })
      }
    }
  })
  await flushPromises()
  return wrapper
}

function markButton(wrapper, key) {
  return wrapper
    .findAll('.page-header-actions > .w-btn')
    .find((b) => b.attributes('aria-label') === `common.page.${key}`)
}

describe('PageHeader favorite and pin toggles', () => {
  it('draws neither for a guest', async () => {
    const wrapper = await mountHeader({ authenticated: false })

    expect(markButton(wrapper, 'favorite')).toBeUndefined()
    expect(markButton(wrapper, 'pin')).toBeUndefined()
  })

  it('draws neither on a redirect stub or a page that is not there', async () => {
    const redirect = await mountHeader({ page: { editor: 'redirect' } })
    expect(markButton(redirect, 'favorite')).toBeUndefined()

    const missing = await mountHeader({ page: { notFound: true } })
    expect(markButton(missing, 'pin')).toBeUndefined()
  })

  it('draws both unpressed for a page that is in neither list', async () => {
    const wrapper = await mountHeader()

    expect(markButton(wrapper, 'favorite').attributes('aria-pressed')).toBe('false')
    expect(markButton(wrapper, 'pin').attributes('aria-pressed')).toBe('false')
  })

  it('draws the pressed state for a page the list says is favorited and pinned', async () => {
    const wrapper = await mountHeader({ favorites: ['page-1'], pinned: ['page-1'] })

    const favorite = markButton(wrapper, 'unfavorite')
    const pin = markButton(wrapper, 'unpin')
    expect(favorite.attributes('aria-pressed')).toBe('true')
    expect(favorite.classes()).toContain('is-marked')
    expect(pin.attributes('aria-pressed')).toBe('true')
    expect(pin.classes()).toContain('is-marked')
  })

  it('PUTs the favorite route, then DELETEs it on the next click', async () => {
    const wrapper = await mountHeader()
    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, isFavorite: true })
    })
    API_CLIENT.delete.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, isFavorite: false })
    })

    await markButton(wrapper, 'favorite').trigger('click')
    await flushPromises()
    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/favorite')
    expect(markButton(wrapper, 'unfavorite')).toBeTruthy()

    await markButton(wrapper, 'unfavorite').trigger('click')
    await flushPromises()
    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1/favorite')
    expect(markButton(wrapper, 'favorite')).toBeTruthy()
  })

  it('PUTs the pin route, then DELETEs it on the next click', async () => {
    const wrapper = await mountHeader()
    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, isPinned: true })
    })
    API_CLIENT.delete.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, isPinned: false })
    })

    await markButton(wrapper, 'pin').trigger('click')
    await flushPromises()
    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/pin')
    expect(useUserPagesStore().isPinned('page-1')).toBe(true)

    await markButton(wrapper, 'unpin').trigger('click')
    await flushPromises()
    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1/pin')
    expect(useUserPagesStore().isPinned('page-1')).toBe(false)
  })

  it('reports a refused change and leaves the button as it was', async () => {
    const wrapper = await mountHeader()
    queue.length = 0
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.reject(new Error('nope')) })

    await markButton(wrapper, 'pin').trigger('click')
    await flushPromises()

    expect(markButton(wrapper, 'pin').attributes('aria-pressed')).toBe('false')
    expect(queue.some((n) => n.message === 'common.page.pinFailed')).toBe(true)
  })
})
