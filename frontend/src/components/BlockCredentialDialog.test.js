import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import BlockCredentialDialog from './BlockCredentialDialog.vue'
import { useAdminStore } from '@/stores/admin'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * `useDialogComponent()` mounts the panel hidden and flips `dialogVisible` true on the tick after
 * mount (see `composables/dialog.js`), so the form isn't in the DOM until that settles.
 */
async function mountDialog(props) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  // -> `<w-dialog>` renders its panel through `<teleport to="body">` (see `WDialog.vue`), which moves
  //    that DOM out from under the component's own root -- stubbing it keeps the panel in place so
  //    `wrapper.find()` can still reach it.
  const wrapper = mount(BlockCredentialDialog, {
    props,
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  await flushPromises()
  return { wrapper, adminStore }
}

describe('BlockCredentialDialog (mode: create)', () => {
  it('disables submit until both name and secret are filled in, enables once both are', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    const submit = () =>
      wrapper.findAll('button').find((btn) => btn.text() === 'admin.blocks.credentialAdd')

    expect(submit().attributes('disabled')).toBeDefined()

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    expect(submit().attributes('disabled')).toBeDefined()

    await inputs[1].setValue('sekret-token')
    expect(submit().attributes('disabled')).toBeUndefined()
  })

  it('creates the credential and emits it on success, secret never in the emitted payload', async () => {
    const { wrapper, adminStore } = await mountDialog({ mode: 'create' })
    const created = { id: 'cred-1', siteId: 'site-1', name: 'Weather API' }
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(created) })

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    await inputs[1].setValue('sekret-token')

    const submit = wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialAdd')
    await submit.trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${adminStore.currentSiteId}/block-credentials`,
      {
        json: { name: 'Weather API', secret: 'sekret-token' }
      }
    )
    expect(wrapper.emitted('ok')).toEqual([[created]])
  })

  it('shows an error and does not emit ok when creation fails', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    const err = Object.assign(new Error('Request failed'), {
      data: { message: 'name is required.' }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockRejectedValue(err) })
    notifyQueue.length = 0

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    await inputs[1].setValue('sekret-token')
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialAdd')
      .trigger('click')
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      caption: 'name is required.'
    })
    expect(wrapper.emitted('ok')).toBeUndefined()
  })
})

describe('BlockCredentialDialog (mode: rotate)', () => {
  it('has no name field, only a secret field, and posts to the rotate route', async () => {
    const { wrapper, adminStore } = await mountDialog({
      mode: 'rotate',
      credential: { id: 'cred-1', name: 'Weather API' }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({ ok: true }) })

    expect(wrapper.findAll('input')).toHaveLength(1)

    await wrapper.find('input').setValue('new-secret')
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialRotate')
      .trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${adminStore.currentSiteId}/block-credentials/cred-1/rotate`,
      { json: { secret: 'new-secret' } }
    )
    expect(wrapper.emitted('ok')).toEqual([[undefined]])
  })
})
