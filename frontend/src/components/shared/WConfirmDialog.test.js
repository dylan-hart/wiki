import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import WConfirmDialog from './WConfirmDialog.vue'
import WDialog from './WDialog.vue'

import { createTestI18n } from '../../../test/i18n.js'

const MESSAGES = {
  'common.actions.ok': 'OK',
  'common.actions.cancel': 'Cancel',
  'common.actions.delete': 'Delete'
}

async function mountDialog(props = {}) {
  const i18n = createTestI18n(MESSAGES)
  const wrapper = mount(WConfirmDialog, {
    props: { title: 'Delete item', message: 'Are you sure?', ...props },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  // -> `useDialogComponent()` mounts the panel hidden and flips `dialogVisible` true on the tick
  //    after mount (see `composables/dialog.js`), matching `PageDeleteDialog.test.js`'s own pattern.
  await flushPromises()
  return wrapper
}

// -> The OK button is always the last one rendered (cancel comes first, when shown at all -- see
//    the template's `<w-space />` / cancel / OK ordering), so finding it by elimination works
//    regardless of what label it carries.
function okButton(wrapper) {
  const buttons = wrapper.findAll('button')
  return buttons[buttons.length - 1]
}

function cancelButton(wrapper) {
  return wrapper.findAll('button').find((b) => b.text() === 'Cancel')
}

function dialogPersistentProp(wrapper) {
  return wrapper.findComponent(WDialog).props('persistent')
}

describe('WConfirmDialog', () => {
  describe('cancel default', () => {
    it('shows a cancel button by default, with no props passed', async () => {
      const wrapper = await mountDialog()

      expect(cancelButton(wrapper)).toBeTruthy()
    })

    it('hides the cancel button when cancel is explicitly false', async () => {
      const wrapper = await mountDialog({ cancel: false })

      expect(cancelButton(wrapper)).toBeFalsy()
    })
  })

  describe('destructive shorthand', () => {
    it('yields a negative-coloured OK button', async () => {
      const wrapper = await mountDialog({ destructive: true })

      const ok = okButton(wrapper)
      expect(ok.element.style.backgroundColor).toBe('var(--color-negative)')
    })

    it('renders a cancel button', async () => {
      const wrapper = await mountDialog({ destructive: true })

      expect(cancelButton(wrapper)).toBeTruthy()
    })

    it('uses the delete label for OK', async () => {
      const wrapper = await mountDialog({ destructive: true })

      expect(okButton(wrapper).text()).toBe('Delete')
    })

    it('still shows the cancel button even if cancel: false is also passed', async () => {
      const wrapper = await mountDialog({ destructive: true, cancel: false })

      expect(cancelButton(wrapper)).toBeTruthy()
    })

    it('does not override an explicit non-default color', async () => {
      const wrapper = await mountDialog({ destructive: true, color: 'warning' })

      expect(okButton(wrapper).element.style.backgroundColor).toBe('var(--color-warning)')
    })

    it('does not override an explicit okLabel', async () => {
      const wrapper = await mountDialog({ destructive: true, okLabel: 'Purge' })

      expect(okButton(wrapper).text()).toBe('Purge')
    })

    it('leaves a non-destructive dialog with the primary color and OK label', async () => {
      const wrapper = await mountDialog()

      const ok = okButton(wrapper)
      expect(ok.element.style.backgroundColor).toBe('var(--color-primary)')
      expect(ok.text()).toBe('OK')
    })
  })

  describe('persistent without a way out', () => {
    it('is not a reachable configuration: persistent is dropped when there is no cancel button', async () => {
      const wrapper = await mountDialog({ persistent: true, cancel: false })

      // -> No cancel button rendered...
      expect(cancelButton(wrapper)).toBeFalsy()
      // -> ...so WDialog must not be told to block backdrop/Escape dismissal either, or OK would be
      //    the only way to close the dialog at all.
      expect(dialogPersistentProp(wrapper)).toBe(false)
    })

    it('keeps persistent active when a cancel button is present', async () => {
      const wrapper = await mountDialog({ persistent: true, cancel: true })

      expect(cancelButton(wrapper)).toBeTruthy()
      expect(dialogPersistentProp(wrapper)).toBe(true)
    })

    it('stays reachable when persistent + destructive are combined without an explicit cancel', async () => {
      // destructive forces cancel true, so persistent should take effect here
      const wrapper = await mountDialog({ persistent: true, destructive: true, cancel: false })

      expect(cancelButton(wrapper)).toBeTruthy()
      expect(dialogPersistentProp(wrapper)).toBe(true)
    })
  })
})
