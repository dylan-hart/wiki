import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ProfileApi from './ProfileApi.vue'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { stubApi } from '../../test/mocks.js'

/**
 * @param {boolean} freshPinia Set false when the caller activated its own Pinia instance and
 *   pre-seeded store state on it, which a fresh one would overwrite before the first render.
 */
function mountPage({ freshPinia = true } = {}) {
  if (freshPinia) {
    setActivePinia(createPinia())
  }

  const i18n = createTestI18n({
    // -> Real wording, so `humanizeDate()`'s `t('common.datetime', …)` renders text, not the key.
    common: {
      datetime: '{date} at {time}'
    },
    profile: {
      api: {
        title: 'API Access',
        subtitle: 'Personal access tokens',
        none: 'You have not created any personal access tokens yet.',
        keyEndingIn: 'Ending in {suffix}',
        newKeyFullAccess: 'Full Access',
        scopedTo: 'Scoped to {scope}',
        keySite: 'Site: {site}',
        newKeySiteAllSites: 'All Sites',
        createdOn: 'Created on {date}',
        expiresOn: 'Expires on {date}',
        listTitle: 'Access Tokens',
        loadFailed: 'Failed to load',
        revoke: 'Revoke',
        revoked: 'Revoked',
        revokedHint: 'This token has been revoked and can no longer be used.'
      }
    }
  })
  return mount(ProfileApi, {
    global: { plugins: [i18n] }
  })
}

describe('ProfileApi', () => {
  it("lists the caller's own tokens from users/profile/api-keys, not the admin api-keys resource", async () => {
    stubApi(
      {
        'users/profile/api-keys': [
          {
            id: 'key-1',
            name: 'My Laptop',
            keyShort: 'abcd',
            scope: null,
            siteId: null,
            userId: 'user-1',
            isRevoked: false,
            isInvalidated: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            expiration: '2099-01-01T00:00:00.000Z'
          }
        ],
        sites: []
      },
      { fallback: [] }
    )

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith('users/profile/api-keys')
    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalledWith('api-keys')
    expect(wrapper.vm.state.keys).toHaveLength(1)
    expect(wrapper.vm.state.keys[0].name).toBe('My Laptop')
  })

  it("still lists the caller's tokens when GET /sites 403s, since ordinary users lack read:sites/access:admin", async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'sites') {
        return { json: () => Promise.reject(new Error('403 Forbidden')) }
      }
      return {
        json: () =>
          Promise.resolve([
            {
              id: 'key-1',
              name: 'My Laptop',
              keyShort: 'abcd',
              scope: null,
              siteId: null,
              userId: 'user-1',
              isRevoked: false,
              isInvalidated: false,
              createdAt: '2026-01-01T00:00:00.000Z',
              expiration: '2099-01-01T00:00:00.000Z'
            }
          ])
      }
    })

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // -> A 403 on `sites` is the expected case for most of this page's audience, so bundling both
    //    calls into one `Promise.all` would take the token list down with it.
    expect(wrapper.vm.state.keys).toHaveLength(1)
    expect(wrapper.vm.state.sites).toStrictEqual([])
  })

  it('opens the revoke dialog against the self-service endpoint, not the admin one', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const key = { id: 'key-1', name: 'My Laptop' }
    wrapper.vm.revoke(key)
    await wrapper.vm.$nextTick()

    // -> `revoke()` returns nothing: what it opened is reachable only through `openDialogs`.
    const { openDialogs } = await import('@/composables/dialog')
    const opened = openDialogs.at(-1)
    expect(opened.props.endpoint).toBe('users/profile/api-keys')
    expect(opened.props.labelPrefix).toBe('profile.api')
    expect(opened.props.apiKey).toStrictEqual(key)
  })

  it('renders createdOn through the store formatter, so a stored timezone changes it', async () => {
    stubApi(
      {
        'users/profile/api-keys': [
          {
            id: 'key-1',
            name: 'My Laptop',
            keyShort: 'abcd',
            scope: null,
            siteId: null,
            userId: 'user-1',
            isRevoked: false,
            isInvalidated: false,
            createdAt: '2026-03-04T15:30:00.000Z',
            expiration: '2099-01-01T00:00:00.000Z'
          }
        ],
        sites: []
      },
      { fallback: [] }
    )

    setActivePinia(createPinia())
    const userStore = useUserStore()
    // -> UTC+9, nowhere near the runner's own zone, and set BEFORE mounting so the first render
    //    already reflects it rather than a later reactive re-render.
    userStore.timezone = 'Asia/Tokyo'
    userStore.dateFormat = 'YYYY-MM-DD'
    userStore.timeFormat = '24h'

    const wrapper = mountPage({ freshPinia: false })

    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // -> `createdAt` above, nine hours ahead: 15:30Z rolls over into the next local day.
    expect(wrapper.text()).toContain('2026-03-05 at 00:30')
  })

  it('draws each token as a settings row, and marks an unusable one on the plate itself', async () => {
    stubApi(
      {
        'users/profile/api-keys': [
          {
            id: 'key-1',
            name: 'My Laptop',
            keyShort: 'abcd',
            scope: null,
            siteId: null,
            userId: 'user-1',
            isRevoked: false,
            isInvalidated: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            expiration: '2099-01-01T00:00:00.000Z'
          },
          {
            id: 'key-2',
            name: 'Old Laptop',
            keyShort: 'efgh',
            scope: null,
            siteId: null,
            userId: 'user-1',
            isRevoked: true,
            isInvalidated: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            expiration: '2099-01-01T00:00:00.000Z'
          }
        ],
        sites: []
      },
      { fallback: [] }
    )

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const rows = wrapper.findAll('.w-settings-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.w-settings-row__label').text()).toBe('My Laptop')
    expect(rows[0].find('.blueprint-icon').exists()).toBe(true)
    expect(rows[0].find('.w-settings-row__hint').text()).toContain('Ending in abcd')

    expect(rows[0].find('.blueprint-icon .w-badge').exists()).toBe(false)
    expect(rows[1].find('.blueprint-icon .w-badge').exists()).toBe(true)
    expect(rows[1].find('.w-settings-row__hint').text()).toContain('Revoked')

    const revoke = rows[1]
      .find('.w-settings-row__control')
      .findAll('button')
      .find((btn) => btn.attributes('aria-label') === 'Revoke')
    expect(revoke.attributes('disabled')).toBeDefined()
  })

  it('renders neither the empty-state card nor the tokens card while the initial fetch is in flight', async () => {
    let resolveKeys
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'users/profile/api-keys') {
        return {
          json: () =>
            new Promise((resolve) => {
              resolveKeys = resolve
            })
        }
      }
      return { json: () => Promise.resolve([]) }
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.loading).toBeGreaterThan(0)
    expect(wrapper.vm.state.keys).toHaveLength(0)
    expect(wrapper.text()).not.toContain('Access Tokens')
    expect(wrapper.text()).not.toContain('You have not created any personal access tokens yet.')

    resolveKeys([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('You have not created any personal access tokens yet.')
    expect(wrapper.text()).not.toContain('Access Tokens')
  })

  it('runs the header band full width as the page root’s first child, with the actions below it', async () => {
    stubApi({ 'users/profile/api-keys': [], sites: [] }, { fallback: [] })

    const wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const header = wrapper.find('h1.w-section-header')
    expect(header.exists()).toBe(true)
    // -> A flex cell beside the buttons would collapse the band to the text column's width.
    expect(header.element.parentElement).toBe(wrapper.element)

    const actionsBar = wrapper.find('.actions-bar')
    expect(actionsBar.exists()).toBe(true)
    expect(header.findAll('button')).toHaveLength(0)
    expect(actionsBar.find('[aria-label="common.actions.refresh"]').exists()).toBe(true)
    expect(actionsBar.text()).toContain('profile.api.newKeyButton')
  })
})
