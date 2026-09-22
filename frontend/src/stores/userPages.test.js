import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from './site.js'
import { useUserStore } from './user.js'
import { useUserPagesStore } from './userPages.js'

function reply(payload) {
  return { json: () => Promise.resolve(payload) }
}

function rejection(error) {
  return { json: () => Promise.reject(error) }
}

function seed({ authenticated = true } = {}) {
  setActivePinia(createPinia())
  useSiteStore().id = 'site-1'
  useUserStore().authenticated = authenticated
  return useUserPagesStore()
}

beforeEach(() => {
  seed()
})

describe('userPages store: recordVisit()', () => {
  it('PUTs the visit route for a logged-in user', async () => {
    const store = seed()
    API_CLIENT.put.mockReturnValueOnce(reply({ ok: true }))

    await store.recordVisit('page-1')

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/visit')
  })

  it('makes no call for a guest', async () => {
    const store = seed({ authenticated: false })

    await store.recordVisit('page-1')

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('does not repeat the page it recorded last, but records another and then the first again', async () => {
    const store = seed()
    API_CLIENT.put.mockReturnValue(reply({ ok: true }))

    await store.recordVisit('page-1')
    await store.recordVisit('page-1')
    await store.recordVisit('page-2')
    await store.recordVisit('page-1')

    expect(API_CLIENT.put).toHaveBeenCalledTimes(3)
  })

  it('swallows a failure and lets the same page be retried', async () => {
    const store = seed()
    API_CLIENT.put.mockReturnValueOnce(rejection(new Error('offline')))

    await expect(store.recordVisit('page-1')).resolves.toBeUndefined()
    await store.recordVisit('page-1')

    expect(API_CLIENT.put).toHaveBeenCalledTimes(2)
  })
})

describe('userPages store: load()', () => {
  it('fills the favorite and pinned ids from the list route', async () => {
    const store = seed()
    API_CLIENT.get.mockReturnValueOnce(
      reply({
        recent: [{ pageId: 'r' }],
        favorites: [{ pageId: 'f1' }, { pageId: 'f2' }],
        pinned: [{ pageId: 'p1' }]
      })
    )

    await store.load()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/user-pages')
    expect(store.isFavorite('f2')).toBe(true)
    expect(store.isFavorite('p1')).toBe(false)
    expect(store.isPinned('p1')).toBe(true)
  })

  it('fetches once per site', async () => {
    const store = seed()
    API_CLIENT.get.mockReturnValue(reply({ recent: [], favorites: [], pinned: [] }))

    await store.load()
    await store.load()
    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)

    useSiteStore().id = 'site-2'
    await store.load()
    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)
  })

  it('makes no call for a guest', async () => {
    const store = seed({ authenticated: false })

    await store.load()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('leaves the lists empty and tries again next time when the request fails', async () => {
    const store = seed()
    API_CLIENT.get.mockReturnValueOnce(rejection(new Error('offline')))

    await store.load()
    expect(store.favoriteIds).toEqual([])

    API_CLIENT.get.mockReturnValueOnce(reply({ favorites: [{ pageId: 'f1' }] }))
    await store.load()
    expect(store.isFavorite('f1')).toBe(true)
  })
})

describe('userPages store: setFavorite() / setPinned()', () => {
  it('PUTs the favorite route and marks the page', async () => {
    const store = seed()
    API_CLIENT.put.mockReturnValueOnce(reply({ ok: true, isFavorite: true }))

    await store.setFavorite('page-1', true)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/favorite')
    expect(store.isFavorite('page-1')).toBe(true)
    expect(store.isPinned('page-1')).toBe(false)
  })

  it('DELETEs the favorite route and unmarks the page', async () => {
    const store = seed()
    store.favoriteIds = ['page-1']
    API_CLIENT.delete.mockReturnValueOnce(reply({ ok: true, isFavorite: false }))

    await store.setFavorite('page-1', false)

    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1/favorite')
    expect(store.isFavorite('page-1')).toBe(false)
  })

  it('PUTs and DELETEs the pin route', async () => {
    const store = seed()
    API_CLIENT.put.mockReturnValueOnce(reply({ ok: true, isPinned: true }))
    await store.setPinned('page-1', true)
    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/pin')
    expect(store.isPinned('page-1')).toBe(true)

    API_CLIENT.delete.mockReturnValueOnce(reply({ ok: true, isPinned: false }))
    await store.setPinned('page-1', false)
    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1/pin')
    expect(store.isPinned('page-1')).toBe(false)
  })

  it('moves the store before the reply arrives', () => {
    const store = seed()
    API_CLIENT.put.mockReturnValueOnce({ json: () => new Promise(() => {}) })

    store.setFavorite('page-1', true)

    expect(store.isFavorite('page-1')).toBe(true)
  })

  it('puts the state back and rethrows when the server refuses', async () => {
    const store = seed()
    store.pinnedIds = ['other']
    API_CLIENT.put.mockReturnValueOnce(rejection(new Error('nope')))

    await expect(store.setPinned('page-1', true)).rejects.toThrow('nope')

    expect(store.pinnedIds).toEqual(['other'])
  })
})
