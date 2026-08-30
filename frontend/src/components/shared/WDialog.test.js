import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

import WDialog from './WDialog.vue'
import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

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

function mountRealDialog(props = {}) {
  const wrapper = mount(WDialog, {
    props: { modelValue: true, ...props },
    slots: { default: '<div class="dialog-content">Hello</div>' },
    attachTo: document.body
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

describe('WDialog interaction', () => {
  it('renders nothing into the body while closed', () => {
    mountedWrappers.push(mount(WDialog, { props: { modelValue: false }, attachTo: document.body }))

    expect(body().find('.w-dialog-backdrop').exists()).toBe(false)
    expect(body().find('.w-dialog-panel').exists()).toBe(false)
  })

  it('opens on model-value: true, teleporting the panel and backdrop into document.body', async () => {
    mountRealDialog()
    await nextTick()

    expect(body().find('.w-dialog-backdrop').exists()).toBe(true)
    const panel = body().find('.w-dialog-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Hello')
  })

  it('emits update:modelValue(false) on a backdrop click', async () => {
    const wrapper = mountRealDialog()
    await nextTick()

    await body().find('.w-dialog-backdrop').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('emits update:modelValue(false) on Escape', async () => {
    const wrapper = mountRealDialog()
    await nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('removes its document keydown listener once closed -- a later Escape does nothing', async () => {
    const wrapper = mountRealDialog()
    await nextTick()

    await wrapper.setProps({ modelValue: false })
    await nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('a persistent dialog ignores both a backdrop click and Escape', async () => {
    const wrapper = mountRealDialog({ persistent: true })
    await nextTick()

    await body().find('.w-dialog-backdrop').trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
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

function dispatchTab({ shiftKey = false } = {}) {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  )
}

/**
 * OpenProject #1608: `WDialog` traps and places focus itself -- capturing the trigger on open,
 * moving focus into the panel (or onto the panel, `tabindex="-1"`, when it has nothing tabbable),
 * cycling Tab/Shift+Tab at the panel's ends, restoring the trigger on close/unmount, and letting only
 * the topmost of several stacked dialogs trap. Real (unstubbed) `teleport` throughout, so assertions
 * read `document.activeElement` the way a browser actually would.
 */
/**
 * Opens a `WDialog` the way every real caller does -- mounted closed, then flipped open by a
 * reactive prop change (a `v-model` toggle, or `useDialogComponent()`'s own post-mount tick) -- never
 * mounted with `modelValue: true` from the very first render. This isn't just fidelity to real usage:
 * `flush: 'post'`'s *immediate* invocation runs before Vue's own template-ref assignment (both are
 * queued post-render, but the watcher's is registered earlier, at `<script setup>` evaluation, than
 * the ref's, which is only registered once the panel's `v-if` actually patches in) but its *reactive*
 * invocations -- triggered by a real prop change after mount -- run through the ordinary effect
 * ordering where the ref is already live, exactly like every real dialog open.
 */
async function openDialog(props = {}, slots = {}) {
  const wrapper = mount(WDialog, { props: { modelValue: false, ...props }, slots })
  await flushPromises()
  await wrapper.setProps({ modelValue: true })
  await flushPromises()
  return wrapper
}

describe('WDialog focus management', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete document.body.dataset.wDialogDepth
    document.body.style.overflow = ''
  })

  it('moves focus to the first tabbable descendant when the dialog opens', async () => {
    await openDialog(
      {},
      { default: '<button id="first">First</button><button id="second">Second</button>' }
    )

    expect(document.activeElement?.id).toBe('first')
  })

  it('focuses the panel itself (tabindex="-1") when it has no tabbable descendants', async () => {
    await openDialog({}, { default: '<p>Nothing focusable here</p>' })

    const panel = new DOMWrapper(document.body).find('[role="dialog"]')
    expect(document.activeElement).toBe(panel.element)
    expect(panel.attributes('tabindex')).toBe('-1')
  })

  it('cycles Tab from the last tabbable descendant back to the first', async () => {
    await openDialog(
      {},
      { default: '<button id="first">First</button><button id="second">Second</button>' }
    )

    document.getElementById('second').focus()
    dispatchTab()

    expect(document.activeElement?.id).toBe('first')
  })

  it('cycles Shift+Tab from the first tabbable descendant to the last', async () => {
    await openDialog(
      {},
      { default: '<button id="first">First</button><button id="second">Second</button>' }
    )

    document.getElementById('first').focus()
    dispatchTab({ shiftKey: true })

    expect(document.activeElement?.id).toBe('second')
  })

  it('restores focus to the previously focused element on close', async () => {
    const trigger = document.createElement('button')
    trigger.id = 'trigger'
    document.body.appendChild(trigger)
    trigger.focus()

    const wrapper = await openDialog({}, { default: '<button id="first">First</button>' })
    expect(document.activeElement?.id).toBe('first')

    await wrapper.setProps({ modelValue: false })
    await flushPromises()

    expect(document.activeElement).toBe(trigger)
  })

  it('restores focus to the trigger on unmount while still open', async () => {
    const trigger = document.createElement('button')
    trigger.id = 'trigger'
    document.body.appendChild(trigger)
    trigger.focus()

    const wrapper = await openDialog({}, { default: '<button id="first">First</button>' })

    // -> Unmounted while still open, e.g. a route change or host teardown
    wrapper.unmount()

    expect(document.activeElement).toBe(trigger)
  })

  it('only the topmost of two stacked dialogs traps Tab', async () => {
    const outer = await openDialog(
      {},
      {
        default:
          '<button id="outer-first">Outer first</button><button id="outer-last">Outer last</button>'
      }
    )

    const inner = await openDialog(
      {},
      {
        default:
          '<button id="inner-first">Inner first</button><button id="inner-last">Inner last</button>'
      }
    )

    // -> The dialog opened on top starts with initial focus
    expect(document.activeElement?.id).toBe('inner-first')

    document.getElementById('inner-last').focus()
    dispatchTab()
    // -> The topmost (inner) dialog traps: wraps back to its own first control
    expect(document.activeElement?.id).toBe('inner-first')

    // -> The outer panel is not `inert` (only `#app` is, and the teleported panel sits outside it),
    //    so it can still take real focus -- but Tab pressed there is handled by the topmost (inner)
    //    dialog's own listener, which finds focus outside its panel and pulls it back in rather than
    //    leaving it free to wrap within the (non-topmost) outer dialog
    document.getElementById('outer-last').focus()
    dispatchTab()
    expect(document.activeElement?.id).toBe('inner-first')

    inner.unmount()
    outer.unmount()
  })

  it("lets composables/dialog.js's autofocus override the default initial-focus target", async () => {
    const AutofocusHost = defineComponent({
      emits: [...dialogComponentEmits],
      setup() {
        const second = ref(null)
        const { dialogVisible } = useDialogComponent({ autofocus: () => second.value })
        return () =>
          h(WDialog, { modelValue: dialogVisible.value }, () => [
            h('button', { id: 'af-first' }, 'First'),
            h('button', { id: 'af-second', ref: second }, 'Second')
          ])
      }
    })

    mount(AutofocusHost)
    // -> Mirrors `useDialogComponent()`'s own timing: mount -> tick (dialogVisible = true) -> tick
    //    (autofocus target focused)
    await flushPromises()
    await nextTick()
    await nextTick()

    expect(document.activeElement?.id).toBe('af-second')
  })
})
