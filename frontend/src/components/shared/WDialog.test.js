import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

import WDialog from './WDialog.vue'
import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import tailwindCss from '@/css/tailwind.css?raw'

/*
  The teleport makes the panel a SIBLING of `#app`, not a descendant, which is why `#app` is the only
  element `inert` can land on and still leave the panel interactive. Stubbing `teleport` is fine
  here: what is under test is the side effect on `#app`, not the teleported markup.
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

    wrapper.unmount()

    expect(appRoot.hasAttribute('inert')).toBe(false)
    expect(document.body.dataset.wDialogDepth).toBe('0')
  })
})

/**
 * The teleport lands the panel outside `@vue/test-utils`'s tracked tree, so `wrapper.find()` never
 * sees it; every query below reads the real DOM through a `DOMWrapper(document.body)` instead.
 */

function body() {
  return new DOMWrapper(document.body)
}

let mountedWrappers = []

afterEach(() => {
  // -> Unmount first: `WDialog` binds its Escape listener on `document` itself while open, which a
  //    bare `document.body.innerHTML = ''` would leave dangling across tests
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
 * `labelledBy`/`ariaLabel` have to be real props, not fallthrough attributes: `WDialog` binds
 * `$attrs` on the teleport root so it can carry a caller's `class`, so a bare `aria-labelledby`
 * would name that wrapper instead of the `role="dialog"` panel.
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

/*
  Real (unstubbed) teleport throughout, so `document.activeElement` reads the way a browser's would.
*/
/**
 * Mounted closed, then flipped open by a prop change, never mounted with `modelValue: true`: the
 * open watcher's `flush: 'post'` IMMEDIATE invocation runs before Vue assigns the panel's template
 * ref (the watcher is registered earlier, at `<script setup>` evaluation), while its reactive
 * invocations run once the ref is live -- which is what every real dialog open does.
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

    expect(document.activeElement?.id).toBe('inner-first')

    document.getElementById('inner-last').focus()
    dispatchTab()
    expect(document.activeElement?.id).toBe('inner-first')

    // -> The outer panel can still take real focus (only `#app` is `inert`, and a teleported panel
    //    sits outside it), but Tab there is handled by the topmost dialog, which pulls focus back
    //    into its own panel rather than letting it wrap within the outer one
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
    // -> `useDialogComponent()`'s timing: mount -> tick (visible) -> tick (autofocus target focused)
    await flushPromises()
    await nextTick()
    await nextTick()

    expect(document.activeElement?.id).toBe('af-second')
  })
})

/**
 * The lock is a depth counter shared by every instance, and the scroll-lock watcher is
 * `{ immediate: true }`, so it fires at mount even for a dialog that mounts closed. The failure
 * mode guarded here: such an instance releasing a lock it never took, unlocking the page behind a
 * dialog still on screen.
 */

afterEach(() => {
  // -> Lock state lives on `document.body`, so it leaks between tests unless reset
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
   * Asserted against the stylesheet source because the clamp holds by being a different property on
   * a different element than the dialog cards' inline `min-width`, not by winning the cascade --
   * nothing a computed style in this environment could show.
   */
  it('clamps .w-dialog-panel to the viewport width, matching the p-4 gutter', () => {
    expect(tailwindCss).toMatch(/\.w-dialog-panel\s*\{[^}]*max-width:\s*calc\(100vw - 2rem\)/)
  })

  /**
   * A wide inner card still overflows the clamped panel on a narrow viewport, since the clamp caps
   * the panel and not the child asking for room inside it. Plain `justify-center` would centre that
   * overflow, pushing the start edge off screen with no way to scroll back to it;
   * `justify-center-safe` falls back to start-alignment exactly when content overflows.
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

describe('WDialog corner radius', () => {
  it('rounds all corners with rounded-dialog for the standard position', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true, position: 'standard' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.classes()).toContain('rounded-dialog')
    expect(panel.classes()).not.toContain('rounded-lg')
  })

  it('rounds all corners with rounded-dialog for the right (side panel) position', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true, position: 'right' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.classes()).toContain('rounded-dialog')
    expect(panel.classes()).not.toContain('rounded-lg')
  })

  it('rounds only the top corners with rounded-t-dialog for the bottom position', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true, position: 'bottom' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.classes()).toContain('rounded-t-dialog')
    expect(panel.classes()).toContain('rounded-b-none')
    expect(panel.classes()).not.toContain('rounded-t-lg')
  })
})

/**
 * `.w-dialog-viewport` is `fixed inset-0`, so any horizontal overflow it takes reads as a page-wide
 * horizontal scrollbar -- which the right-slide transition's transient `translateX` causes under a
 * plain `overflow-auto`. The panel's `max-width` clamp means the viewport never legitimately needs
 * horizontal scroll, so the axes are split, for every position rather than only the one that showed
 * it.
 */
describe('WDialog viewport overflow', () => {
  it.each(['standard', 'right', 'bottom'])(
    'clips horizontal overflow but keeps vertical scroll for the %s position',
    (position) => {
      const wrapper = mount(WDialog, {
        props: { modelValue: true, position },
        global: { stubs: { teleport: true } }
      })

      const viewport = wrapper.find('.w-dialog-viewport')
      expect(viewport.classes()).toContain('overflow-x-hidden')
      expect(viewport.classes()).toContain('overflow-y-auto')
      expect(viewport.classes()).not.toContain('overflow-auto')
    }
  )
})

/**
 * Plain pixel values rather than the `clamp(...)` real callers pass: jsdom's `cssstyle` cannot parse
 * `clamp()` and silently drops the whole `:style` binding. What is under test is the prop plumbing
 * and precedence, so the values themselves do not matter.
 */
describe('WDialog width/height', () => {
  it('applies width and height as inline panel styles when full-width/full-height are unset', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true, width: '480px', height: '360px' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.attributes('style')).toContain('width: 480px')
    expect(panel.attributes('style')).toContain('height: 360px')
    expect(panel.classes()).not.toContain('w-full')
    expect(panel.classes()).not.toContain('h-full')
  })

  it('ignores width in favor of the w-full class when fullWidth is also set', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true, fullWidth: true, width: '480px' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.classes()).toContain('w-full')
    expect(panel.attributes('style') ?? '').not.toContain('width:')
  })

  it('ignores height in favor of the h-full class when fullHeight is also set', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true, fullHeight: true, height: '360px' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.classes()).toContain('h-full')
    expect(panel.attributes('style') ?? '').not.toContain('height:')
  })

  it('width takes priority over maxWidth when both are given', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true, width: '480px', maxWidth: '550px' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.attributes('style')).toContain('width: 480px')
    expect(panel.attributes('style') ?? '').not.toContain('max-width: 550px')
  })
})

/**
 * Escape must reach a nested `WMenu` dropdown before the dialog, or closing the dropdown discards
 * the in-progress form behind it. Real (unstubbed) teleport throughout, since what is under test is
 * genuine DOM event order, which a stubbed teleport would not exercise.
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
        // -> A real, natively-focusable button has to wrap `<w-menu>`: it resolves its trigger by
        //    climbing from its placeholder span's parent
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

    // -> A persistent dialog declines Escape rather than consuming it, so the menu below it on the
    //    stack still gets a turn
    expect(document.querySelector('.w-menu')).toBeNull()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    wrapper.unmount()
  })

  /**
   * Escape goes through the shared LIFO stack, so the most recently opened dialog closes first --
   * the same "topmost wins" rule Tab-trapping and initial focus follow, not registration order.
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
