import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import { loading } from '@/composables/loading'
import { queue as notifyQueue } from '@/composables/notify'
import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { useAdminSettings } from './adminSettings.js'

/*
  The composable is the load/save skeleton the admin settings pages share, so what is asserted here is
  the orchestration around a page's own `fetch`/`commit`: the loading gauge and the full-screen
  overlay, the three toasts and their keys, the merge over `defaults()`, the site-switch watcher and
  the "am I editing the site I'm browsing" gate on `onSavedCurrentSite`.
*/

const I18N_PREFIX = 'admin.general'

/**
 * `useAdminSettings` calls `useI18n()`, `onMounted()` and two stores, so it needs a real component
 * instance -- this mounts a harness whose only job is to run the composable and hand back what it
 * returned, alongside the stores the caller may want to drive.
 *
 * `siteId` is applied before the composable runs, so the mounted load a real page gets is the only
 * thing that has happened by the time a test starts: the site watcher does not also fire. Everything
 * the mount did is cleared before the test's own call, so counts are the test's own.
 */
async function mountComposable({ siteId = null, messages = {}, ...opts } = {}) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: messages },
    missingWarn: false,
    fallbackWarn: false
  })

  let api = null
  let adminStore = null
  let siteStore = null
  let mountedFetches = 0

  const fetch = opts.fetch ?? vi.fn().mockResolvedValue({})

  const wrapper = mount(
    {
      setup() {
        adminStore = useAdminStore()
        siteStore = useSiteStore()
        adminStore.currentSiteId = siteId
        api = useAdminSettings({
          i18nPrefix: I18N_PREFIX,
          ...opts,
          fetch
        })
        return () => null
      }
    },
    { global: { plugins: [i18n] } }
  )

  await flushPromises()
  mountedFetches = fetch.mock.calls.length
  vi.clearAllMocks()
  notifyQueue.splice(0)

  return { api, adminStore, siteStore, wrapper, mountedFetches }
}

/** A ky `HTTPError` as `helpers/apiError.js` reads it -- the parsed `{ ok, error, message }` envelope. */
function apiError({ error, message } = {}) {
  return Object.assign(new Error(message ?? 'Request failed'), { data: { error, message } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  notifyQueue.splice(0)
  vi.restoreAllMocks()
})

describe('useAdminSettings() load', () => {
  it('fetches for the administered site and merges the result over the defaults', async () => {
    const fetch = vi.fn().mockResolvedValue({ theme: { colorPrimary: '#000' } })
    const { api } = await mountComposable({
      siteId: 'site-1',
      defaults: () => ({ colorPrimary: '#FFF', dark: false }),
      pick: (resp) => resp.theme,
      fetch
    })

    await api.load()

    expect(fetch).toHaveBeenCalledWith('site-1')
    expect(api.state.config).toEqual({ colorPrimary: '#000', dark: false })
    expect(api.state.loading).toBe(0)
    expect(notifyQueue).toHaveLength(0)
  })

  it('hands the raw response to onLoaded for the state a page keeps outside its config', async () => {
    const onLoaded = vi.fn()
    const resp = { auth: {}, assets: { loginBg: true } }
    const { api } = await mountComposable({
      siteId: 'site-1',
      fetch: vi.fn().mockResolvedValue(resp),
      extraState: { hasBg: false },
      onLoaded
    })

    await api.load()

    expect(onLoaded).toHaveBeenCalledWith(resp)
    expect(api.state.hasBg).toBe(false)
  })

  it('pairs the full-screen overlay around the request', async () => {
    const { api } = await mountComposable({ siteId: 'site-1' })
    const show = vi.spyOn(loading, 'show')
    const hide = vi.spyOn(loading, 'hide')

    await api.load()

    expect(show).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('leaves the overlay alone for a page that never showed one', async () => {
    const { api } = await mountComposable({ siteId: 'site-1', overlay: false })
    const show = vi.spyOn(loading, 'show')
    const hide = vi.spyOn(loading, 'hide')

    await api.load()

    expect(show).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
  })

  it('reports a failed load with the server message as the caption, and still hides the overlay', async () => {
    const { api } = await mountComposable({
      siteId: 'site-1',
      fetch: vi.fn().mockRejectedValue(apiError({ message: 'Site not found' }))
    })
    const hide = vi.spyOn(loading, 'hide')

    await api.load()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: `${I18N_PREFIX}.loadFailed`,
      caption: 'Site not found'
    })
    expect(hide).toHaveBeenCalled()
    expect(api.state.loading).toBe(0)
  })

  it('does not fetch at all for a site-scoped page with no site selected yet', async () => {
    const fetch = vi.fn().mockResolvedValue({})
    const { api } = await mountComposable({ fetch })

    await api.load()

    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches on mount for a page that is not site-scoped', async () => {
    const { mountedFetches } = await mountComposable({ siteScoped: false })

    expect(mountedFetches).toBe(1)
  })

  it('takes a per-page key override for a page whose locale stem differs', async () => {
    const { api } = await mountComposable({
      siteId: 'site-1',
      i18nPrefix: 'admin.editors',
      keys: { loadFailed: 'admin.editors.fetchFailed' },
      fetch: vi.fn().mockRejectedValue(new Error('nope'))
    })

    await api.load()

    expect(notifyQueue.at(-1)).toMatchObject({ message: 'admin.editors.fetchFailed' })
  })
})

describe('useAdminSettings() save', () => {
  it('commits the edited config, reports success and answers that it saved', async () => {
    const commit = vi.fn().mockResolvedValue(undefined)
    const { api } = await mountComposable({
      siteId: 'site-1',
      defaults: () => ({ title: 'My Wiki' }),
      commit
    })

    const ok = await api.save()

    expect(commit).toHaveBeenCalledWith('site-1', api.state.config)
    expect(ok).toBe(true)
    expect(api.state.loading).toBe(0)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: `${I18N_PREFIX}.saveSuccess`
    })
  })

  it('captions a failed save with the page message for the server error code', async () => {
    const { api } = await mountComposable({
      siteId: 'site-1',
      messages: { 'admin.general.hostnameTaken': 'That hostname is already in use' },
      commit: vi.fn().mockRejectedValue(apiError({ error: 'hostnameTaken', message: 'Taken' }))
    })

    const ok = await api.save()

    expect(ok).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: `${I18N_PREFIX}.saveFailed`,
      caption: 'That hostname is already in use'
    })
    expect(api.state.loading).toBe(0)
  })

  it('falls back to the server message when the page has none for that code', async () => {
    const { api } = await mountComposable({
      siteId: 'site-1',
      commit: vi.fn().mockRejectedValue(apiError({ error: 'someUnknownCode', message: 'Refused' }))
    })

    await api.save()

    expect(notifyQueue.at(-1)).toMatchObject({ caption: 'Refused' })
  })

  it('runs onSavedCurrentSite only when the administered site is the one being browsed', async () => {
    const onSaved = vi.fn()
    const onSavedCurrentSite = vi.fn()
    const { api, siteStore } = await mountComposable({
      siteId: 'site-1',
      commit: vi.fn().mockResolvedValue(undefined),
      onSaved,
      onSavedCurrentSite
    })
    siteStore.$patch({ id: 'site-2' })

    await api.save()

    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSavedCurrentSite).not.toHaveBeenCalled()

    siteStore.$patch({ id: 'site-1' })
    await api.save()

    expect(onSaved).toHaveBeenCalledTimes(2)
    expect(onSavedCurrentSite).toHaveBeenCalledTimes(1)
  })

  it('runs neither hook when the commit failed', async () => {
    const onSaved = vi.fn()
    const onSavedCurrentSite = vi.fn()
    const { api, siteStore } = await mountComposable({
      siteId: 'site-1',
      commit: vi.fn().mockRejectedValue(new Error('nope')),
      onSaved,
      onSavedCurrentSite
    })
    siteStore.$patch({ id: 'site-1' })

    await api.save()

    expect(onSaved).not.toHaveBeenCalled()
    expect(onSavedCurrentSite).not.toHaveBeenCalled()
  })

  it('runs onSaved before onSavedCurrentSite, and awaits it', async () => {
    const order = []
    const onSaved = vi.fn(async () => {
      await Promise.resolve()
      order.push('onSaved')
    })
    const onSavedCurrentSite = vi.fn(() => {
      order.push('onSavedCurrentSite')
    })
    const { api, siteStore } = await mountComposable({
      siteId: 'site-1',
      commit: vi.fn().mockResolvedValue(undefined),
      onSaved,
      onSavedCurrentSite
    })
    siteStore.$patch({ id: 'site-1' })

    await api.save()

    // -> Awaited, not merely called first: a page whose `onSaved` refetches something
    //    `onSavedCurrentSite` then reads would otherwise see the value it had before the save.
    expect(order).toEqual(['onSaved', 'onSavedCurrentSite'])
  })

  it('reports a throwing onSaved as a failed save', async () => {
    const onSavedCurrentSite = vi.fn()
    const { api, siteStore } = await mountComposable({
      siteId: 'site-1',
      commit: vi.fn().mockResolvedValue(undefined),
      onSaved: vi.fn().mockRejectedValue(apiError({ error: 'afterSave', message: 'Hook failed' })),
      onSavedCurrentSite
    })
    siteStore.$patch({ id: 'site-1' })

    const ok = await api.save()

    // -> The commit itself went through and its success toast was already raised, but the page has
    //    something left undone -- so `save()` answers false and the failure is reported, rather than
    //    the page carrying on as if everything had landed.
    expect(ok).toBe(false)
    expect(onSavedCurrentSite).not.toHaveBeenCalled()
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: `${I18N_PREFIX}.saveFailed`,
      caption: 'Hook failed'
    })
    expect(api.state.loading).toBe(0)
  })

  it('gates nothing on the browsed site for a page that is not site-scoped', async () => {
    const onSavedCurrentSite = vi.fn()
    const { api } = await mountComposable({
      siteScoped: false,
      commit: vi.fn().mockResolvedValue(undefined),
      onSavedCurrentSite
    })

    await api.save()

    expect(onSavedCurrentSite).toHaveBeenCalledTimes(1)
  })
})

describe('useAdminSettings() refresh', () => {
  it('reloads and reports success', async () => {
    const fetch = vi.fn().mockResolvedValue({})
    const { api } = await mountComposable({ siteId: 'site-1', fetch })

    await api.refresh()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: `${I18N_PREFIX}.refreshSuccess`
    })
  })

  it('still reports success on top of a failed reload, as every page it replaces did', async () => {
    const { api } = await mountComposable({
      siteId: 'site-1',
      fetch: vi.fn().mockRejectedValue(new Error('nope'))
    })

    await api.refresh()

    expect(notifyQueue.map((entry) => entry.type)).toEqual(['negative', 'positive'])
  })
})

describe('useAdminSettings() site wiring', () => {
  it('loads on mount for the site already being administered', async () => {
    const { mountedFetches } = await mountComposable({ siteId: 'site-1' })

    expect(mountedFetches).toBe(1)
  })

  it('loads nothing on mount when no site is being administered yet', async () => {
    const { mountedFetches } = await mountComposable()

    expect(mountedFetches).toBe(0)
  })

  it('reloads when the admin switches site', async () => {
    const fetch = vi.fn().mockResolvedValue({})
    const { adminStore } = await mountComposable({ fetch })

    adminStore.currentSiteId = 'site-1'
    await flushPromises()

    expect(fetch).toHaveBeenCalledWith('site-1')

    adminStore.currentSiteId = 'site-2'
    await flushPromises()

    expect(fetch).toHaveBeenLastCalledWith('site-2')
  })

  it('does not watch the administered site for a page that is not site-scoped', async () => {
    const fetch = vi.fn().mockResolvedValue({})
    const { adminStore } = await mountComposable({ siteScoped: false, fetch })

    adminStore.currentSiteId = 'site-1'
    await flushPromises()

    expect(fetch).not.toHaveBeenCalled()
  })
})
