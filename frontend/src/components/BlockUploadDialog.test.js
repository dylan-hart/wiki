import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import BlockUploadDialog from './BlockUploadDialog.vue'
import { useAdminStore } from '@/stores/admin'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

/**
 * `useDialogComponent()` mounts the panel hidden and flips `dialogVisible` true on the tick after
 * mount (see `composables/dialog.js`), so the form isn't in the DOM until that settles.
 */
async function mountDialog() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  // -> `system/security` is best-effort (see the component's own comment); resolving it here with no
  //    `uploadMaxFileSize` exercises the "keep the default" branch, matching an admin with no
  //    `manage:system` for whom the real backend would 403.
  API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({}) })

  const i18n = createTestI18n()
  // -> `<w-dialog>` renders its panel through `<teleport to="body">` (see `WDialog.vue`), which moves
  //    that DOM out from under the component's own root -- stubbing it keeps the panel in place so
  //    `wrapper.find()` can still reach it.
  const wrapper = mount(BlockUploadDialog, {
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  await flushPromises()
  return { wrapper, adminStore }
}

/** A `File`-shaped object with a settable `.type`, since jsdom/happy-dom's real `File` is awkward to
 *  drive through `<input type="file">` under a headless test. */
function fakeFile(name, size, type = 'text/javascript') {
  return { name, size, type }
}

function selectFile(wrapper, file) {
  const input = wrapper.find('input[type="file"]').element
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  return wrapper.find('input[type="file"]').trigger('change')
}

describe('BlockUploadDialog', () => {
  it('rejects a non-.js file client-side, without calling the API', async () => {
    const { wrapper } = await mountDialog()
    notifyQueue.length = 0

    await selectFile(wrapper, fakeFile('component.mjs', 10))

    expect(wrapper.text()).toContain('admin.blocks.uploadInvalidExtension')
    expect(wrapper.find('.block-upload-submit').attributes('disabled')).toBeDefined()
    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })

  it('rejects an oversized file client-side, without calling the API', async () => {
    const { wrapper } = await mountDialog()

    await selectFile(wrapper, fakeFile('component.js', 999_999_999))

    expect(wrapper.text()).toContain('admin.blocks.uploadTooLarge')
    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })

  it('uploads a valid file and emits the created block on success', async () => {
    const { wrapper, adminStore } = await mountDialog()
    const block = { id: 'b1', block: 'custom-thing', name: 'Custom Thing', isCustom: true }
    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ ok: true, block })
    })

    await selectFile(wrapper, fakeFile('component.js', 10))
    await wrapper.find('.block-upload-submit').trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${adminStore.currentSiteId}/blocks`,
      expect.objectContaining({ body: expect.objectContaining({ name: 'component.js' }) })
    )
    expect(wrapper.emitted('ok')).toEqual([[block]])
  })

  it('maps a backend validation failure to a readable message via apiErrorMessage, and keeps the dialog open', async () => {
    const { wrapper } = await mountDialog()
    const err = Object.assign(new Error('Request failed with status code 409'), {
      data: { ok: false, message: 'A block already registers the tag "block-foo" on this site.' }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockRejectedValue(err) })
    notifyQueue.length = 0

    await selectFile(wrapper, fakeFile('component.js', 10))
    await wrapper.find('.block-upload-submit').trigger('click')
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'A block already registers the tag "block-foo" on this site.'
    })
    expect(wrapper.emitted('ok')).toBeUndefined()
  })
})
