import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'

import WDialog from './WDialog.vue'
import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog.js'

/**
 * OpenProject #1608 ("Trap, place and restore focus in `WDialog`"), part of the Epic #1606 modal
 * contract (focus trap, initial/restored focus, `inert` background, accessible name -- this WP
 * covers everything but `inert` and the accessible name).
 *
 * `<w-dialog>` teleports its panel to the real `document.body` regardless of where the wrapper
 * itself is attached, so every assertion below reads the live DOM (`document.body` /
 * `document.activeElement`) rather than `wrapper.find(...)`. `attachTo: document.body` is still
 * used for the wrapper's own root, matching the pattern `EditorPickerDialog.test.js` already
 * established for a teleporting dialog.
 */

function findPanel() {
  return document.body.querySelector('.w-dialog-panel')
}

afterEach(() => {
  // -> Defensive: every test below closes/unmounts what it opens, but a failed assertion mid-test
  //    could leave the depth counter, scroll lock or teleported markup behind for the next test.
  document.body.innerHTML = ''
  delete document.body.dataset.wDialogDepth
  document.body.style.overflow = ''
})

describe('WDialog focus trap', () => {
  it('places initial focus on the first tabbable descendant of the panel', async () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: false },
      slots: { default: '<button>First</button><button>Second</button>' },
      attachTo: document.body
    })

    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    expect(document.activeElement.textContent).toBe('First')

    wrapper.unmount()
  })

  it('falls back to focusing the panel itself, with tabindex="-1", when it has no tabbable content', async () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: false },
      slots: { default: '<p>Nothing to focus here.</p>' },
      attachTo: document.body
    })

    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    const panel = findPanel()
    expect(document.activeElement).toBe(panel)
    expect(panel.getAttribute('tabindex')).toBe('-1')

    wrapper.unmount()
  })

  it('cycles focus with Tab at the last element and Shift+Tab at the first', async () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: false },
      slots: { default: '<button>First</button><button>Middle</button><button>Last</button>' },
      attachTo: document.body
    })

    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    const buttons = [...findPanel().querySelectorAll('button')]
    const [first, , last] = buttons

    last.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    )
    expect(document.activeElement).toBe(first)

    first.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    )
    expect(document.activeElement).toBe(last)

    wrapper.unmount()
  })

  it('restores focus to the previously focused element when the dialog closes', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open dialog'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const wrapper = mount(WDialog, {
      props: { modelValue: false },
      slots: { default: '<button>Inside</button>' },
      attachTo: document.body
    })

    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    // -> Sanity: focus actually moved into the panel before we assert it comes back
    expect(document.activeElement.textContent).toBe('Inside')

    await wrapper.setProps({ modelValue: false })
    await flushPromises()

    expect(document.activeElement).toBe(trigger)

    wrapper.unmount()
    trigger.remove()
  })

  it('restores focus to the previously focused element when the dialog unmounts while open', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open dialog'
    document.body.appendChild(trigger)
    trigger.focus()

    const wrapper = mount(WDialog, {
      props: { modelValue: true },
      slots: { default: '<button>Inside</button>' },
      attachTo: document.body
    })

    await flushPromises()
    expect(document.activeElement.textContent).toBe('Inside')

    wrapper.unmount()

    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('only the topmost of two stacked dialogs traps Tab', async () => {
    // -> Mounted already-open (rather than mounted closed then flipped via setProps): both
    //    dialogs need to be open at once, and mounting a SECOND closed `WDialog` while a first
    //    is already open hits a pre-existing bug in the unrelated depth/scroll-lock watcher
    //    (`immediate: true` firing its "closing" branch on a dialog that never opened, wrongly
    //    decrementing the shared counter) -- out of scope for this WP's focus-trap work.
    const bottom = mount(WDialog, {
      props: { modelValue: true },
      slots: { default: '<button>bottom-first</button><button>bottom-last</button>' },
      attachTo: document.body
    })
    await flushPromises()

    const top = mount(WDialog, {
      props: { modelValue: true },
      slots: { default: '<button>top-first</button><button>top-last</button>' },
      attachTo: document.body
    })
    await flushPromises()

    expect(document.body.dataset.wDialogDepth).toBe('2')
    // -> The top dialog's own initial-focus placement, not the bottom's
    expect(document.activeElement.textContent).toBe('top-first')

    // Force focus onto the bottom (background) dialog's content, then press Tab. The bottom
    // dialog's own listener recognises it is no longer the topmost and does nothing; the top
    // dialog's listener is the one that acts, pulling focus back into itself rather than the
    // bottom dialog cycling within its own two buttons.
    const bottomButtons = [...document.querySelectorAll('.w-dialog-panel button')].filter((b) =>
      b.textContent.startsWith('bottom-')
    )
    const bottomLast = bottomButtons.find((b) => b.textContent === 'bottom-last')
    bottomLast.focus()
    expect(document.activeElement).toBe(bottomLast)

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    )

    // -> Landed inside the TOP panel, not wrapped back to `bottom-first` the way the bottom
    //    dialog's own trap would have if it (wrongly) still owned the key
    expect(document.activeElement.textContent).toBe('top-first')

    top.unmount()
    bottom.unmount()
  })

  it('keeps working for the nine dialogs that opt into useDialogComponent({ autofocus }), overriding the default first-tabbable focus', async () => {
    const AutofocusHost = defineComponent({
      components: { WDialog },
      emits: dialogComponentEmits,
      setup() {
        const secondField = ref(null)
        const { dialogVisible, onDialogHide } = useDialogComponent({
          autofocus: () => secondField.value
        })
        return { dialogVisible, onDialogHide, secondField }
      },
      template: `
        <w-dialog v-model="dialogVisible" @hide="onDialogHide">
          <button>not the autofocus target</button>
          <input ref="secondField" aria-label="autofocus target" />
        </w-dialog>
      `
    })

    const wrapper = mount(AutofocusHost, { attachTo: document.body })
    await flushPromises()

    expect(document.activeElement.tagName).toBe('INPUT')
    expect(document.activeElement.getAttribute('aria-label')).toBe('autofocus target')

    wrapper.unmount()
  })
})
