import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
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

/*
  `<w-dialog>` renders its panel through `<teleport to="body">` (see `WDialog.vue`), which is exactly
  what makes `document.getElementById('app')` -- not some ancestor of the `<w-dialog>` component
  instance -- the only element `inert` can land on and still work: the panel itself ends up as a
  sibling of `#app`, not a descendant, once teleported. Stubbing `teleport` (same convention every
  other `WDialog` consumer test in this workspace uses, e.g. `PageDeleteDialog.test.js`) is fine here
  because what's under test is the side effect on `document`/`#app`, not the teleported markup itself.
*/
function mountDialog(props = {}) {
  return mount(WDialog, {
    props: { modelValue: false, ...props },
    global: { stubs: { teleport: true } }
  })
}

function appendAppRoot() {
  const appRoot = document.createElement('div')
  appRoot.id = 'app'
  document.body.appendChild(appRoot)
  return appRoot
}

describe('WDialog', () => {
  let appRoot

  beforeEach(() => {
    appRoot = appendAppRoot()
  })

  afterEach(() => {
    appRoot.remove()
    delete document.body.dataset.wDialogDepth
    document.body.style.overflow = ''
    document.body.removeAttribute('inert')
  })

  it("sets inert on the app root while open, and never on body (the panel's real teleported ancestor)", async () => {
    const wrapper = mountDialog({ modelValue: true })
    await flushPromises()

    expect(appRoot.hasAttribute('inert')).toBe(true)
    expect(document.body.hasAttribute('inert')).toBe(false)

    wrapper.unmount()
  })

  it('does not set inert while closed', async () => {
    const wrapper = mountDialog({ modelValue: false })
    await flushPromises()

    expect(appRoot.hasAttribute('inert')).toBe(false)

    wrapper.unmount()
  })

  it('stays inert while a second dialog opens and closes on top of the first', async () => {
    const first = mountDialog({ modelValue: true })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    const second = mountDialog({ modelValue: true })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    await second.setProps({ modelValue: false })
    await flushPromises()
    // -> First dialog is still open, so the background must stay inert
    expect(appRoot.hasAttribute('inert')).toBe(true)

    first.unmount()
    second.unmount()
  })

  it('removes inert only when the last dialog closes', async () => {
    const first = mountDialog({ modelValue: true })
    await flushPromises()
    const second = mountDialog({ modelValue: true })
    await flushPromises()

    await second.setProps({ modelValue: false })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    await first.setProps({ modelValue: false })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(false)

    first.unmount()
    second.unmount()
  })

  it('removes inert on unmount, mirroring the existing scroll-lock cleanup', async () => {
    const wrapper = mountDialog({ modelValue: true })
    await flushPromises()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    // -> Unmounted while still open, e.g. a route change or host teardown
    wrapper.unmount()

    expect(appRoot.hasAttribute('inert')).toBe(false)
    expect(document.body.dataset.wDialogDepth).toBe('0')
  })
})

/**
 * OpenProject #1617: `WDialog` gains `labelledBy`/`ariaLabel` props bound on the `role="dialog"`
 * panel, giving every dialog in the app an accessible name. They must be real props rather than
 * fallthrough attributes -- `WDialog` sets `inheritAttrs: false` and binds `$attrs` on the
 * teleport root (`.w-dialog-root`) so it can carry a caller's `class`, and a bare
 * `aria-labelledby`/`aria-label` attribute would land there instead of on the panel.
 *
 * `WDialog` teleports its content to `document.body`, outside `@vue/test-utils`'s own tracked
 * tree, so assertions read the real DOM through a `DOMWrapper(document.body)` -- the same pattern
 * `ApiKeyCreateDialog.test.js` and `GlossaryTermDialog.test.js` use for this component.
 */
describe('WDialog accessible name', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('gives the panel a non-empty accessible name via `labelledBy`, referencing an id in its content', () => {
    mount(WDialog, {
      props: { modelValue: true, labelledBy: 'site-info-heading' },
      slots: {
        default: '<div id="site-info-heading">Site info</div>'
      }
    })

    const body = new DOMWrapper(document.body)
    const panel = body.find('[role="dialog"]')

    expect(panel.attributes('aria-labelledby')).toBe('site-info-heading')

    const referenced = body.find('#site-info-heading')
    expect(referenced.exists()).toBe(true)
    expect(referenced.text().trim().length).toBeGreaterThan(0)
  })

  it('gives the panel a non-empty accessible name via `ariaLabel`', () => {
    mount(WDialog, {
      props: { modelValue: true, ariaLabel: 'Delete page' },
      slots: { default: '<p>Are you sure?</p>' }
    })

    const panel = new DOMWrapper(document.body).find('[role="dialog"]')
    expect(panel.attributes('aria-label')).toBe('Delete page')
    expect(panel.attributes('aria-label').length).toBeGreaterThan(0)
  })

  it('leaves both attributes off the teleport root, only the panel carries them', () => {
    mount(WDialog, {
      props: { modelValue: true, labelledBy: 'some-heading', ariaLabel: 'Some dialog' },
      slots: { default: '<div id="some-heading">Some dialog</div>' }
    })

    const root = new DOMWrapper(document.body).find('.w-dialog-root')
    expect(root.attributes('aria-labelledby')).toBeUndefined()
    expect(root.attributes('aria-label')).toBeUndefined()

    const panel = new DOMWrapper(document.body).find('[role="dialog"]')
    expect(panel.attributes('aria-labelledby')).toBe('some-heading')
    expect(panel.attributes('aria-label')).toBe('Some dialog')
  })

  it('renders neither attribute when the props are unset', () => {
    mount(WDialog, {
      props: { modelValue: true },
      slots: { default: '<p>Content</p>' }
    })

    const panel = new DOMWrapper(document.body).find('[role="dialog"]')
    expect(panel.attributes('aria-labelledby')).toBeUndefined()
    expect(panel.attributes('aria-label')).toBeUndefined()
  })
})
