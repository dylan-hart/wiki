import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AssetRenameDialog from './AssetRenameDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/*
  `WDialog`'s content lives behind a `<teleport to="body">`, which lands it as a REAL child of
  `document.body`, outside `@vue/test-utils`'s own tracked tree -- unmounting the wrapper is what
  removes it again, matching the pattern `GlossaryTermDialog.test.js` established.
*/
let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
  notifyQueue.splice(0, notifyQueue.length)
})

function mountDialog(props) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  const i18n = createTestI18n({
    fileman: {
      assetRename: 'Rename Asset',
      assetFileName: 'Asset Name',
      assetFileNameHint: 'Filename of the asset, including the file extension.',
      renameAssetInvalid: 'Asset name is invalid.',
      renameAssetSuccess: 'Asset renamed successfully.'
    },
    common: { actions: { cancel: 'Cancel', rename: 'Rename' } }
  })
  currentWrapper = mount(AssetRenameDialog, {
    props: { assetId: 'asset-1', ...props },
    global: { plugins: [i18n] }
  })
  return currentWrapper
}

/**
 * OpenProject #2055: the filename check that used to live inline in `rename()` -- thrown as an
 * `Error` and surfaced only as a toast, detached from the field it was actually about -- is now a
 * `:rules` entry on the field itself, validated through the enclosing `<w-form>` before any API call
 * is even attempted.
 */
describe('AssetRenameDialog filename validation (OpenProject #2055)', () => {
  it('rejects an invalid filename inline, under the control, with no toast and no API call', async () => {
    API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ id: 'asset-1', fileName: 'a' })
    })
    const wrapper = mountDialog()
    await flushPromises()

    await wrapper.vm.rename()
    await flushPromises()

    // -> `WInput`'s error/hint line -- the `.min-h-5` div under the control -- is what carries the
    //    error now, not a toast disappearing on a timer
    const errorNode = document.body.querySelector('.min-h-5')
    expect(errorNode?.textContent).toContain('Asset name is invalid.')
    expect(notifyQueue).toHaveLength(0)
    expect(API_CLIENT.patch).not.toHaveBeenCalled()
  })

  it('rejects a name with no extension', async () => {
    API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ id: 'asset-1', fileName: 'no-extension' })
    })
    const wrapper = mountDialog()
    await flushPromises()

    await wrapper.vm.rename()

    expect(notifyQueue).toHaveLength(0)
    expect(API_CLIENT.patch).not.toHaveBeenCalled()
  })

  it('proceeds with the API call for a valid filename', async () => {
    API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ id: 'asset-1', fileName: 'old-name.png' })
    })
    API_CLIENT.patch.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })
    const wrapper = mountDialog()
    await flushPromises()
    wrapper.vm.state.path = 'new-name.png'

    await wrapper.vm.rename()

    expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/site-1/assets/asset-1', {
      json: { fileName: 'new-name.png' }
    })
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
  })

  it('has no lazy-rules without a matching :rules binding', async () => {
    API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ id: 'asset-1', fileName: 'a' })
    })
    mountDialog()
    await flushPromises()
    const input = currentWrapper.findComponent({ name: 'WInput' })
    expect(input.props('lazyRules')).toBe('ondemand')
    expect(input.props('rules').length).toBeGreaterThan(0)
  })
})
