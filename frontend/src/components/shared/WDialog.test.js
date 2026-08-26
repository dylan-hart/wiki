import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import WDialog from './WDialog.vue'

/**
 * `WDialog` renders behind a `<teleport to="body">`, which lands its content as a real child of
 * `document.body`, outside `@vue/test-utils`'s own tracked tree -- `wrapper.find()` never sees it.
 * Every query below goes through the real DOM instead, via a `DOMWrapper(document.body)`, matching
 * the pattern `ApiKeyCreateDialog.test.js` and `ImportBatchPageDialog.test.js` already established
 * for this component.
 *
 * `WDialog.vue` implements no focus management of its own, so this suite deliberately does not
 * assert on focus restoration -- see the file's own doc comment.
 */

function body() {
  return new DOMWrapper(document.body)
}

let mountedWrappers = []

afterEach(() => {
  // -> Unmounts every wrapper this test mounted first: `WDialog` binds its Escape listener on
  //    `document` itself while open, which a bare `document.body.innerHTML = ''` would leave
  //    dangling across tests.
  for (const wrapper of mountedWrappers) {
    wrapper.unmount()
  }
  mountedWrappers = []
  document.body.innerHTML = ''
  delete document.body.dataset.wDialogDepth
  document.body.style.overflow = ''
})

function mountDialog(props = {}) {
  const wrapper = mount(WDialog, {
    props: { modelValue: true, ...props },
    slots: { default: '<div class="dialog-content">Hello</div>' },
    attachTo: document.body
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

describe('WDialog', () => {
  it('renders nothing into the body while closed', () => {
    mountedWrappers.push(mount(WDialog, { props: { modelValue: false }, attachTo: document.body }))

    expect(body().find('.w-dialog-backdrop').exists()).toBe(false)
    expect(body().find('.w-dialog-panel').exists()).toBe(false)
  })

  it('opens on model-value: true, teleporting the panel and backdrop into document.body', async () => {
    mountDialog()
    await nextTick()

    expect(body().find('.w-dialog-backdrop').exists()).toBe(true)
    const panel = body().find('.w-dialog-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Hello')
  })

  it('emits update:modelValue(false) on a backdrop click', async () => {
    const wrapper = mountDialog()
    await nextTick()

    await body().find('.w-dialog-backdrop').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('emits update:modelValue(false) on Escape', async () => {
    const wrapper = mountDialog()
    await nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('removes its document keydown listener once closed -- a later Escape does nothing', async () => {
    const wrapper = mountDialog()
    await nextTick()

    await wrapper.setProps({ modelValue: false })
    await nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('a persistent dialog ignores both a backdrop click and Escape', async () => {
    const wrapper = mountDialog({ persistent: true })
    await nextTick()

    await body().find('.w-dialog-backdrop').trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
