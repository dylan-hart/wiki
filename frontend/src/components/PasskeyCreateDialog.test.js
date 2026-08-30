import { beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import PasskeyCreateDialog from './PasskeyCreateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * OpenProject #2060: the submit handler used to validate by throwing inside `save()` and surfacing
 * the message as a toast. Moved onto the app's one validation convention (`:rules` + a `w-form` ref,
 * `validate()` called at the top of the submit handler), matching `FolderRenameDialog` /
 * `AssetRenameDialog`.
 */
async function mountDialog() {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { profile: { passkeysInvalidName: 'Please enter a valid name.' } } }
  })
  const wrapper = mount(PasskeyCreateDialog, {
    props: {},
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  await flushPromises()
  return wrapper
}

describe('PasskeyCreateDialog validation', () => {
  beforeEach(() => {
    notifyQueue.length = 0
  })

  it('shows an inline field error and makes no notify() call for an empty name', async () => {
    const wrapper = await mountDialog()

    await wrapper.vm.save()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Please enter a valid name.')
    expect(notifyQueue).toHaveLength(0)
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('rejects a name over 255 characters with the same inline error', async () => {
    const wrapper = await mountDialog()

    await wrapper.find('input').setValue('a'.repeat(256))
    await wrapper.vm.save()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Please enter a valid name.')
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('emits ok with the entered name once it is valid', async () => {
    const wrapper = await mountDialog()

    await wrapper.find('input').setValue('My Security Key')
    await wrapper.vm.save()

    expect(wrapper.emitted('ok')).toEqual([[{ name: 'My Security Key' }]])
  })
})
