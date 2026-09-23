import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { handleAuthLinkResult, readAuthLinkResult } from './authLinkResult'
import { queue as notifyQueue } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestRouter } from '../../test/router.js'

const STRINGS = {
  'profile.authConnectSuccess': 'Sign-in method connected.',
  'profile.authConnectFailed': 'Could not connect the sign-in method.',
  'error.ERR_LINK_IDENTITY_IN_USE': 'That identity is already connected to another account.'
}

function t(key) {
  return STRINGS[key] ?? key
}

async function handle(path, { authenticated = true } = {}) {
  const router = await createTestRouter(['/:pathMatch(.*)*'], path)
  const siteStore = useSiteStore()
  const userStore = useUserStore()
  userStore.authenticated = authenticated
  const handled = handleAuthLinkResult(router.currentRoute.value, {
    router,
    siteStore,
    userStore,
    t
  })
  await flushPromises()
  return { handled, router, siteStore }
}

describe('readAuthLinkResult', () => {
  it('reads a connected strategy', () => {
    expect(readAuthLinkResult({ authLink: 'added', strategyId: 'strat-1' })).toMatchObject({
      ok: true,
      strategyId: 'strat-1'
    })
  })

  it('reads an error code', () => {
    expect(readAuthLinkResult({ authLinkError: 'ERR_LINK_IDENTITY_IN_USE' })).toMatchObject({
      ok: false,
      code: 'ERR_LINK_IDENTITY_IN_USE'
    })
  })

  it('drops an error value that is not an error code, so a crafted link cannot put its own words in the toast', () => {
    expect(readAuthLinkResult({ authLinkError: 'Call +1 555 0100 now' })).toMatchObject({
      ok: false,
      code: null
    })
  })

  it('ignores a query with neither parameter', () => {
    expect(readAuthLinkResult({ tab: 'x' })).toBeNull()
    expect(readAuthLinkResult({ authLink: 'removed' })).toBeNull()
  })
})

describe('handleAuthLinkResult', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('announces a connected method, opens Profile on its auth section and strips the parameters', async () => {
    const { handled, router, siteStore } = await handle(
      '/en/some/page?tab=x&authLink=added&strategyId=strat-1#top'
    )

    expect(handled).toBe(true)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: 'Sign-in method connected.'
    })
    expect(siteStore.overlay).toBe('Profile')
    expect(siteStore.overlayOpts).toEqual({ section: 'auth' })
    expect(router.currentRoute.value.path).toBe('/en/some/page')
    expect(router.currentRoute.value.query).toEqual({ tab: 'x' })
    expect(router.currentRoute.value.hash).toBe('#top')
  })

  it('reports a refused connection with the localized error', async () => {
    const { router, siteStore } = await handle('/?authLinkError=ERR_LINK_IDENTITY_IN_USE')

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Could not connect the sign-in method.',
      caption: 'That identity is already connected to another account.'
    })
    expect(siteStore.overlay).toBe('Profile')
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('reports the failure without opening Profile for a visitor who is not signed in', async () => {
    const { siteStore } = await handle('/?authLinkError=ERR_LINK_NOT_SIGNED_IN', {
      authenticated: false
    })

    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })
    expect(siteStore.overlay).not.toBe('Profile')
  })

  it('does nothing on a route without the parameters', async () => {
    const { handled, siteStore } = await handle('/some/page?tab=x')

    expect(handled).toBe(false)
    expect(siteStore.overlay).not.toBe('Profile')
  })
})
