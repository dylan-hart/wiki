import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

import PasskeyCreateDialog from './PasskeyCreateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

const messages = {
  profile: {
    passkeysAdd: 'Add Passkey',
    passkeysName: 'Passkey Name',
    passkeysNameHint: 'Enter a name for your passkey:',
    passkeysInvalidName: 'Passkey name is missing or invalid.'
  },
  common: {
    actions: {
      cancel: 'Cancel',
      save: 'Save'
    }
  }
}

async function mountDialog() {
  const i18n = createTestI18n(messages)
  const wrapper = mount(PasskeyCreateDialog, {
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  // -> `useDialogComponent` flips `dialogVisible` (and mounts `WDialog`'s panel) a tick after mount
  await flushPromises()
  return wrapper
}

describe('PasskeyCreateDialog', () => {
  /*
    OpenProject #2060: the dialog used to validate by throwing inside `save()` and surfacing the
    message as a toast -- the one dialog in the app not following the `:rules` + inline-error
    convention. An invalid entry now fails `WForm#validate()`, which renders the message under the
    field, and `save()` returns early without ever throwing or calling `notify()`.
  */
  it('shows an inline field error and does not notify or emit ok when the name is empty', async () => {
    notifyQueue.length = 0
    const wrapper = await mountDialog()

    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'Save')
      .trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Passkey name is missing or invalid.')
    expect(notifyQueue).toHaveLength(0)
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('shows an inline field error for a name over 255 characters, without notifying', async () => {
    notifyQueue.length = 0
    const wrapper = await mountDialog()

    await wrapper.find('input').setValue('a'.repeat(256))
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'Save')
      .trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Passkey name is missing or invalid.')
    expect(notifyQueue).toHaveLength(0)
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('emits ok with the trimmed-valid name once the field passes validation', async () => {
    notifyQueue.length = 0
    const wrapper = await mountDialog()

    await wrapper.find('input').setValue('My Laptop')
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'Save')
      .trigger('click')
    await flushPromises()

    expect(wrapper.emitted('ok')).toEqual([[{ name: 'My Laptop' }]])
    expect(notifyQueue).toHaveLength(0)
  })
})
