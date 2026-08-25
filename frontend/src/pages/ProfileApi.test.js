import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import ProfileApi from './ProfileApi.vue'

/**
 * OpenProject #788: `ProfileApi.vue` is the self-service counterpart to `AdminApi.vue` -- it lists
 * and lets a user manage only their OWN personal access tokens, through `users/profile/api-keys`
 * rather than the admin-only `api-keys` resource, and shows no groups picker or global enable/disable
 * switch (neither makes sense for a token that always carries the caller's own current permissions).
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
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
            loadFailed: 'Failed to load'
          }
        }
      }
    }
  })
  return mount(ProfileApi, {
    global: { plugins: [i18n] }
  })
}

describe('ProfileApi', () => {
  it("lists the caller's own tokens from users/profile/api-keys, not the admin api-keys resource", async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      const payloads = {
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
      }
      return { json: () => Promise.resolve(payloads[resource] ?? []) }
    })

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

    // -> The keys list must not be a casualty of the sites fetch failing -- see OpenProject #788's
    //    ProfileApi.vue history: bundling both calls into one Promise.all meant a 403 on `sites`
    //    (the expected case for most of this page's actual audience) took the whole load down with it.
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

    // -> `revoke()` opens a dialog via the shared `openDialogs` list rather than returning anything
    //    itself, so this reaches into what it queued rather than a return value.
    const { openDialogs } = await import('@/composables/dialog')
    const opened = openDialogs.at(-1)
    expect(opened.props.endpoint).toBe('users/profile/api-keys')
    expect(opened.props.labelPrefix).toBe('profile.api')
    expect(opened.props.apiKey).toStrictEqual(key)
  })
})
