import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AssetRenameDialog from './AssetRenameDialog.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * OpenProject #2055: `lazy-rules="ondemand"` was set with no `:rules` binding at all, so the
 * "invalid name" check ran only inside `rename()`, throwing to a toast detached from the field.
 * Moved onto the app's one validation convention (`:rules` + `w-form.validate()`), matching
 * `FolderRenameDialog`.
 */
async function mountDialog() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({
    json: vi.fn().mockResolvedValue({ id: 'asset-1', fileName: 'photo.jpg' })
  })

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { fileman: { renameAssetInvalid: 'Invalid file name.' } } }
  })
  const wrapper = mount(AssetRenameDialog, {
    props: { assetId: 'asset-1' },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  await flushPromises()
  return { wrapper, siteStore }
}

describe('AssetRenameDialog validation', () => {
  beforeEach(() => {
    notifyQueue.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows an inline field error and makes no notify() call for an invalid name', async () => {
    const { wrapper } = await mountDialog()

    await wrapper.find('input').setValue('bad')
    await wrapper.vm.rename()
    await flushPromises()

    expect(wrapper.text()).toContain('Invalid file name.')
    expect(notifyQueue).toHaveLength(0)
    expect(API_CLIENT.patch).not.toHaveBeenCalled()
  })

  it('submits the patch and closes when the name is valid', async () => {
    const { wrapper, siteStore } = await mountDialog()
    API_CLIENT.patch.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({ ok: true }) })

    await wrapper.find('input').setValue('renamed.jpg')
    await wrapper.vm.rename()
    await flushPromises()

    expect(API_CLIENT.patch).toHaveBeenCalledWith(`sites/${siteStore.id}/assets/asset-1`, {
      json: { fileName: 'renamed.jpg' }
    })
    expect(wrapper.emitted('ok')).toBeTruthy()
  })
})
