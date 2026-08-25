import { defineComponent } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

import WMenu from './WMenu.vue'

/**
 * OpenProject #1645: the panel renders inside `<teleport to="body">`, appended at the end of the
 * document -- far from its trigger in DOM order -- with no focus management at all. A keyboard user
 * who opened it would have to Tab through the rest of the document to reach its first row, in
 * practice making the menu unreachable.
 *
 * The trigger is climbed from `WMenu`'s hidden placeholder span's own parent (`onMounted` in
 * `WMenu.vue`), the same way the real app writes it (`<w-btn><w-menu>...</w-menu></w-btn>`) -- so the
 * host below wraps `w-menu` in a real, natively-focusable `<button>` rather than mounting `WMenu`
 * bare, which is what lets `document.activeElement` genuinely move onto and off of that button the
 * way a keyboard user's focus would.
 */
const Host = defineComponent({
  components: { WMenu },
  props: {
    autoClose: { type: Boolean, default: false }
  },
  template: `
    <button id="trigger" type="button">
      Open
      <w-menu :auto-close="autoClose">
        <button id="row" type="button">Row</button>
      </w-menu>
    </button>
  `
})

async function openMenu({ autoClose = false } = {}) {
  const wrapper = mount(Host, {
    // -> A detached trigger can never genuinely hold `document.activeElement`
    attachTo: document.body,
    props: { autoClose }
  })
  const trigger = wrapper.get('#trigger')
  trigger.element.focus()
  await trigger.trigger('click')
  await flushPromises()
  return { wrapper, trigger }
}

describe('WMenu focus management', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('moves focus into the panel (its first interactive row) once opened', async () => {
    const { wrapper } = await openMenu()

    const row = document.getElementById('row')
    expect(row).not.toBeNull()
    expect(document.activeElement).toBe(row)

    wrapper.unmount()
  })

  it('returns focus to the trigger on Escape-close', async () => {
    const { wrapper, trigger } = await openMenu()
    expect(document.activeElement).toBe(document.getElementById('row'))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('returns focus to the trigger on outside-click-close', async () => {
    const { wrapper, trigger } = await openMenu()
    expect(document.activeElement).toBe(document.getElementById('row'))

    const catcher = document.body.querySelector('div.fixed.inset-0')
    expect(catcher).not.toBeNull()
    catcher.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('returns focus to the trigger when a row activates and closes the menu (auto-close)', async () => {
    const { wrapper, trigger } = await openMenu({ autoClose: true })
    const row = document.getElementById('row')
    expect(document.activeElement).toBe(row)

    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })
})
