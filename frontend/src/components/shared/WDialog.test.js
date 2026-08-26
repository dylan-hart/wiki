import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'

import WDialog from './WDialog.vue'

/**
 * `WDialog` renders its backdrop/panel through `<teleport to="body">`, so they land as real
 * children of `document.body`, outside `@vue/test-utils`'s own tracked tree -- `wrapper.find()`
 * never sees them. Queried instead through a `DOMWrapper(document.body)`, same pattern as
 * `ApiKeyCreateDialog.test.js`'s scope-tree suite and `EditorCodeBlockMenu.test.js`'s `WMenu`
 * suite. Cleared after every test so one test's teleported nodes are not still sitting in the
 * document for the next.
 */
afterEach(() => {
  document.body.innerHTML = ''
})

function body() {
  return new DOMWrapper(document.body)
}

describe('WDialog', () => {
  it('renders nothing into document.body while closed, and teleports its panel there once open', async () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: false },
      slots: { default: '<div class="dialog-content">Hello</div>' }
    })

    expect(body().find('.dialog-content').exists()).toBe(false)
    expect(body().find('[role="dialog"]').exists()).toBe(false)

    await wrapper.setProps({ modelValue: true })

    expect(body().find('[role="dialog"]').exists()).toBe(true)
    expect(body().find('.dialog-content').text()).toBe('Hello')
  })

  it('emits update:modelValue false on a backdrop click', async () => {
    const wrapper = mount(WDialog, { props: { modelValue: true } })

    await body().find('.w-dialog-backdrop').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('emits update:modelValue false on Escape', async () => {
    const wrapper = mount(WDialog, { props: { modelValue: true } })

    await body().trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('ignores backdrop click and Escape while persistent', async () => {
    const wrapper = mount(WDialog, { props: { modelValue: true, persistent: true } })

    await body().find('.w-dialog-backdrop').trigger('click')
    await body().trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  /**
   * The leak this suite exists to pin (task description): `WDialog` binds a capturing `keydown`
   * listener on `document` for as long as it is open (`WDialog.vue`'s `watch(modelValue, ...)`),
   * and it must come back off again on close -- not merely on unmount, which every other dialog
   * test already exercises for free by tearing its wrapper down.
   */
  it('removes the exact document keydown listener it bound, once closed', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const wrapper = mount(WDialog, { props: { modelValue: true } })

    const keydownCall = addSpy.mock.calls.find(([type]) => type === 'keydown')
    expect(keydownCall).toBeDefined()
    const [, handler, useCapture] = keydownCall
    expect(useCapture).toBe(true)

    const removeSpy = vi.spyOn(document, 'removeEventListener')
    await wrapper.setProps({ modelValue: false })

    expect(removeSpy).toHaveBeenCalledWith('keydown', handler, true)
  })
})
