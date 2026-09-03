import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

import WDialog from './WDialog.vue'
import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import tailwindCss from '@/css/tailwind.css?raw'

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

/**
 * OpenProject #1708: the scroll-lock watcher runs `{ immediate: true }` so it fires once at mount
 * for EVERY instance, including one that mounts already closed (`modelValue` defaults to `false`).
 * The immediate run took the else-branch -- the release path -- decrementing the shared
 * `wDialogDepth` counter and clearing `document.body.style.overflow` even though this instance
 * never incremented it. That is exactly what happens when `PagePropertiesDialog`'s two inline,
 * closed-by-default `<w-dialog>`s mount inside `SideDialog`'s already-open panel: each one takes
 * the shared depth from 1 to 0 and unlocks the page behind a dialog that is still on screen.
 *
 * The fix tracks a component-local `hasLocked` flag, set only by the watcher's open branch, so the
 * release path (both the watcher's else-branch and `onBeforeUnmount`) can only ever hand back a
 * lock this instance actually took.
 */

afterEach(() => {
  // -> The lock state lives on `document.body`, shared across every WDialog instance -- reset it
  //    between tests so one test's leftover depth/overflow can't leak into the next.
  delete document.body.dataset.wDialogDepth
  document.body.style.overflow = ''
})

describe('WDialog scroll-lock reference counting', () => {
  it('does not touch the lock when it mounts already closed', () => {
    mount(WDialog, { props: { modelValue: false } })

    expect(document.body.dataset.wDialogDepth).toBeUndefined()
    expect(document.body.style.overflow).toBe('')
  })

  it('takes the lock when it mounts already open', () => {
    const wrapper = mount(WDialog, { props: { modelValue: true } })

    expect(document.body.dataset.wDialogDepth).toBe('1')
    expect(document.body.style.overflow).toBe('hidden')

    wrapper.unmount()
  })

  it('keeps the lock held while a second, closed dialog mounts on top (the SideDialog shape)', async () => {
    // -> Simulates SideDialog: the panel host dialog is already open (depth 1) before
    //    PagePropertiesDialog's own closed-by-default inline dialogs mount inside it.
    const outer = mount(WDialog, { props: { modelValue: true } })
    expect(document.body.dataset.wDialogDepth).toBe('1')

    const inner = mount(WDialog, { props: { modelValue: false } })

    expect(document.body.dataset.wDialogDepth).toBe('1')
    expect(document.body.style.overflow).toBe('hidden')

    inner.unmount()
    outer.unmount()
  })

  it('releases the lock exactly once when closed after being open, and a second close is a no-op', async () => {
    const wrapper = mount(WDialog, { props: { modelValue: true } })
    expect(document.body.dataset.wDialogDepth).toBe('1')

    await wrapper.setProps({ modelValue: false })

    expect(document.body.dataset.wDialogDepth).toBe('0')
    expect(document.body.style.overflow).toBe('')

    // -> A stray extra `false` (no state change) must not decrement past zero via `hasLocked`
    //    already being cleared -- Math.max(0, ...) already guarded the arithmetic, but the flag is
    //    what stops the release branch from running again at all.
    await wrapper.setProps({ modelValue: false })
    expect(document.body.dataset.wDialogDepth).toBe('0')
  })

  it('releases exactly one level of a stacked lock on close, leaving the other dialog locked', async () => {
    const first = mount(WDialog, { props: { modelValue: true } })
    const second = mount(WDialog, { props: { modelValue: true } })
    expect(document.body.dataset.wDialogDepth).toBe('2')

    await second.setProps({ modelValue: false })

    expect(document.body.dataset.wDialogDepth).toBe('1')
    expect(document.body.style.overflow).toBe('hidden')

    first.unmount()
  })

  it('releases the lock on unmount while open (route change / host teardown)', () => {
    const wrapper = mount(WDialog, { props: { modelValue: true } })
    expect(document.body.dataset.wDialogDepth).toBe('1')

    wrapper.unmount()

    expect(document.body.dataset.wDialogDepth).toBe('0')
    expect(document.body.style.overflow).toBe('')
  })

  it('does not release the lock on unmount while closed', () => {
    const wrapper = mount(WDialog, { props: { modelValue: false } })
    expect(document.body.dataset.wDialogDepth).toBeUndefined()

    wrapper.unmount()

    expect(document.body.dataset.wDialogDepth).toBeUndefined()
    expect(document.body.style.overflow).toBe('')
  })
})

describe('WDialog', () => {
  /**
   * OpenProject #2106: the panel's own clamp lives in `tailwind.css` (a `.w-dialog-panel` component
   * class, not a scoped rule in this SFC -- see the comment on it), because every one of the 19
   * dialog cards sets `min-width` as an inline style on the panel's child, which would otherwise beat
   * a scoped rule at the same specificity tier depending on source order. Asserted against the
   * stylesheet source directly, since that inline style wins the CASCADE in jsdom/happy-dom the same
   * way it would in a real layout -- the clamp only actually holds because it comes from a different
   * property (`max-width` vs. the child's `min-width`) on a different element (the panel vs. its
   * slotted child), not because one rule beats the other.
   */
  it('clamps .w-dialog-panel to the viewport width, matching the p-4 gutter', () => {
    expect(tailwindCss).toMatch(/\.w-dialog-panel\s*\{[^}]*max-width:\s*calc\(100vw - 2rem\)/)
  })

  /**
   * A wide inner card (e.g. `WebhookEditDialog`'s 850px `min-width`) still overflows the clamped
   * panel on a narrow viewport -- the clamp caps the panel, not the child asking for more room
   * inside it. Plain `justify-center` would center that overflow too, pushing the panel's start
   * edge off both sides of the screen with no way to scroll back to it. `justify-center-safe` falls
   * back to start-alignment exactly when the content overflows, which is what keeps the start edge
   * reachable through the viewport's own `overflow-auto`.
   */
  it('centers the standard viewport with safe alignment, not plain centering', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true },
      global: { stubs: { teleport: true } }
    })

    const viewport = wrapper.find('.w-dialog-viewport')
    expect(viewport.classes()).toContain('justify-center-safe')
    expect(viewport.classes()).not.toContain('justify-center')
  })

  it('renders the panel with the clamp class regardless of a wide inner card', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true },
      slots: { default: '<div style="min-width: 850px">wide card</div>' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.classes()).toContain('w-dialog-panel')
    expect(panel.find('div[style*="min-width"]').exists()).toBe(true)
  })
})

/**
 * OpenProject #2370: `WDialog`'s Escape handler used to listen on `document` in the CAPTURE phase,
 * which fires before a nested `WMenu` dropdown's own (bubble-phase, #2364) handler ever gets a turn
 * -- so pressing Escape to close just the dropdown closed the whole dialog instead, discarding an
 * in-progress form (`UserCreateDialog.vue`'s Groups multi-select was the reproduction). Both
 * `WDialog` and `WMenu` teleport to `document.body`, so real (unstubbed) teleport is used throughout,
 * the same as the "WDialog interaction" suite above -- what is under test is genuine DOM event order,
 * which a stubbed teleport wouldn't exercise.
 */
describe('WDialog + nested WMenu Escape', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete document.body.dataset.wDialogDepth
    document.body.style.overflow = ''
  })

  async function mountDialogWithMenu(dialogProps = {}) {
    const wrapper = mount(WDialog, {
      props: { modelValue: true, ...dialogProps },
      attachTo: document.body,
      slots: {
        // -> Mirrors WMenu.test.js's own Host: a real, natively-focusable <button> wraps <w-menu>,
        //    since WMenu resolves its trigger by climbing from its placeholder span's parent.
        default: `
          <button id="menu-trigger" type="button">
            Open menu
            <w-menu>
              <button id="menu-row" type="button">Row</button>
            </w-menu>
          </button>
        `
      }
    })
    await flushPromises()

    const trigger = document.getElementById('menu-trigger')
    trigger.focus()
    await new DOMWrapper(trigger).trigger('click')
    await flushPromises()
    expect(document.querySelector('.w-menu')).not.toBeNull()

    return wrapper
  }

  it('one Escape closes only the nested WMenu dropdown, leaving a non-persistent dialog open', async () => {
    const wrapper = await mountDialogWithMenu()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(document.querySelector('.w-menu')).toBeNull()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    wrapper.unmount()
  })

  it('a second Escape, after the dropdown has closed, then closes the dialog', async () => {
    const wrapper = await mountDialogWithMenu()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])

    wrapper.unmount()
  })

  it('a WMenu dropdown inside a persistent dialog still closes on its own Escape', async () => {
    const wrapper = await mountDialogWithMenu({ persistent: true })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    // -> The persistent dialog declines Escape outright rather than consuming it, so the menu
    //    underneath it on the stack still gets a turn
    expect(document.querySelector('.w-menu')).toBeNull()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    wrapper.unmount()
  })

  /**
   * Not this WP's reported bug, but the same code path: moving Escape onto the shared LIFO stack
   * means the topmost (most recently opened) of two stacked, non-persistent dialogs now closes
   * first -- matching every other "topmost wins" convention in this file (Tab-trapping, initial
   * focus) rather than the old capture-phase registration-order behaviour, which closed whichever
   * dialog had opened FIRST.
   */
  it('closes only the topmost of two stacked, non-persistent dialogs on Escape', async () => {
    const outer = mount(WDialog, { props: { modelValue: true }, attachTo: document.body })
    await flushPromises()
    const inner = mount(WDialog, { props: { modelValue: true }, attachTo: document.body })
    await flushPromises()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(inner.emitted('update:modelValue')).toEqual([[false]])
    expect(outer.emitted('update:modelValue')).toBeUndefined()

    outer.unmount()
    inner.unmount()
  })
})
