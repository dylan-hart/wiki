import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import BlueprintIcon from './BlueprintIcon.vue'
import ApiKeyCreateDialog from './ApiKeyCreateDialog.vue'

/**
 * Covers the site-picker added alongside the scope control (task 622): a new key defaults to
 * `siteId: null` ("All Sites", instance-wide -- identical to a key created before site-pinning
 * existed) and, when a site is picked, that site's ID is what actually reaches the API.
 *
 * `wrapper.vm.state` / `wrapper.vm.create` are reachable directly because `@vue/test-utils` proxies
 * a mounted `<script setup>` component's own setup bindings, not just what it `defineExpose`s --
 * that only gates access from a *parent template* (`ref="x"` + `x.value.foo`), which is not what
 * mounting in a test does.
 */
function mountDialog() {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  return mount(ApiKeyCreateDialog, {
    global: {
      plugins: [i18n],
      components: { BlueprintIcon }
    }
  })
}

describe('ApiKeyCreateDialog site picker', () => {
  it('prepends an "All Sites" (id: null) entry to the fetched sites list', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site-1', title: 'Docs' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.siteOptions).toEqual([
      { id: null, title: 'admin.api.newKeySiteAllSites' },
      { id: 'site-1', title: 'Docs' }
    ])
  })

  it('defaults keySiteId to null and sends it as siteId on create', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site-1', title: 'Docs' }]) }
      }
      if (resource === 'groups') {
        return { json: () => Promise.resolve([{ id: 'group-1', name: 'Editors' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.state.keySiteId).toBe(null)

    wrapper.vm.state.keyName = 'My Key'
    wrapper.vm.state.keyGroups = ['group-1']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({ json: expect.objectContaining({ siteId: null }) })
    )
  })

  it('sends the picked site as siteId on create', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site-1', title: 'Docs' }]) }
      }
      if (resource === 'groups') {
        return { json: () => Promise.resolve([{ id: 'group-1', name: 'Editors' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Key'
    wrapper.vm.state.keyGroups = ['group-1']
    wrapper.vm.state.keySiteId = 'site-1'
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({ json: expect.objectContaining({ siteId: 'site-1' }) })
    )
  })
})
