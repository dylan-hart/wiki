import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import BlueprintIcon from './BlueprintIcon.vue'
import ProfileApiKeyCreateDialog from './ProfileApiKeyCreateDialog.vue'

/**
 * OpenProject #788: the self-service counterpart to `ApiKeyCreateDialog.vue`, minus the groups
 * picker -- a personal token always carries the creating user's own current permissions, so there is
 * nothing to pick there, only the `scope`/`siteId` narrowing every admin-issued key also gets.
 */
function mountDialog() {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  return mount(ProfileApiKeyCreateDialog, {
    global: {
      plugins: [i18n],
      components: { BlueprintIcon }
    }
  })
}

describe('ProfileApiKeyCreateDialog', () => {
  it('posts to users/profile/api-keys with no groups field, unlike the admin-issued form', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site-1', title: 'Docs' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Token'
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({
        json: {
          name: 'My Token',
          expiration: '90d',
          scope: null,
          siteId: null
        }
      })
    )
  })

  it('prepends an "All Sites" (id: null) entry to the fetched sites list, same as the admin form', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site-1', title: 'Docs' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.siteOptions).toEqual([
      { id: null, title: 'profile.api.newKeySiteAllSites' },
      { id: 'site-1', title: 'Docs' }
    ])
  })

  it('sends a non-empty scope selection as the narrowing list, not null', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Token'
    wrapper.vm.state.keyScope = ['read:pages']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({ json: expect.objectContaining({ scope: ['read:pages'] }) })
    )
  })
})
