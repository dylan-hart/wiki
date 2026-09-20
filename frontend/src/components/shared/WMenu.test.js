import { defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, mount, flushPromises } from '@vue/test-utils'

import WMenu from './WMenu.vue'

/**
 * `WMenu` climbs to its trigger from its hidden placeholder's own parent, so the host below wraps
 * `w-menu` in a real, natively-focusable `<button>` rather than mounting `WMenu` bare -- the shape
 * every call site provides, and what lets `document.activeElement` genuinely move onto and off it.
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

describe('WMenu role', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('does not expose a menu role over its non-menuitem children', async () => {
    const { wrapper } = await openMenu()

    expect(document.querySelector('[role="menu"]')).toBeNull()
    const panel = document.querySelector('.w-menu')
    expect(panel).not.toBeNull()
    expect(panel.getAttribute('role')).toBeNull()

    wrapper.unmount()
  })
})

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

  /**
   * A commit-on-blur field inside the panel must get its own Escape handler's turn (discard) before
   * `WMenu`'s moves focus and fires the blur that would commit the in-progress value.
   */
  const EditableHost = defineComponent({
    components: { WMenu },
    data() {
      return { editing: true, draft: 'typed value', committed: null }
    },
    methods: {
      discard() {
        this.editing = false
        this.draft = ''
      },
      commit() {
        if (!this.editing) {
          return
        }
        this.committed = this.draft
        this.editing = false
      }
    },
    template: `
      <button id="trigger" type="button">
        Open
        <w-menu :model-value="true">
          <input id="field" v-model="draft" @keydown.esc="discard" @blur="commit" />
        </w-menu>
      </button>
    `
  })

  it('discards a focused field on Escape instead of committing it on the resulting blur', async () => {
    const wrapper = mount(EditableHost, { attachTo: document.body })
    await flushPromises()

    const field = document.getElementById('field')
    expect(document.activeElement).toBe(field)

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(wrapper.vm.committed).toBeNull()
    expect(wrapper.vm.editing).toBe(false)
    expect(document.querySelector('.w-menu')).toBeNull()

    wrapper.unmount()
  })
})

/**
 * Mounted controlled (`modelValue: true`) so the panel shows on mount rather than needing a trigger
 * climbed and clicked first, and teleported to `body` outside the subtree `@vue/test-utils` tracks
 * -- hence `document` queries rather than `wrapper` ones below.
 */
let rovingFocusWrapper = null

async function mountMenu(slotHtml) {
  rovingFocusWrapper = mount(WMenu, {
    props: { modelValue: true },
    attachTo: document.body,
    slots: { default: slotHtml }
  })
  await rovingFocusWrapper.vm.$nextTick()
  return rovingFocusWrapper
}

function panel() {
  return document.querySelector('.w-menu')
}

function rows() {
  return [...document.querySelectorAll('.w-menu [role="button"], .w-menu a[href]')]
}

async function press(key) {
  panel().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('WMenu roving focus', () => {
  afterEach(() => {
    // -> Explicitly unmounted, not just DOM-wiped: an open `WMenu` holds an Escape registration and
    //    live reactive effects that a bare `document.body.innerHTML = ''` leaves dangling.
    rovingFocusWrapper?.unmount()
    rovingFocusWrapper = null
    document.body.innerHTML = ''
  })

  it('moves focus to the next row on ArrowDown', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item clickable>Two</w-item>
      <w-item clickable>Three</w-item>
    `)
    const [one, two] = rows()
    one.focus()

    await press('ArrowDown')

    expect(document.activeElement).toBe(two)
  })

  it('moves focus to the previous row on ArrowUp', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item clickable>Two</w-item>
      <w-item clickable>Three</w-item>
    `)
    const [one, two] = rows()
    two.focus()

    await press('ArrowUp')

    expect(document.activeElement).toBe(one)
  })

  it('wraps from the last row to the first on ArrowDown', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item clickable>Two</w-item>
      <w-item clickable>Three</w-item>
    `)
    const [first, , last] = rows()
    last.focus()

    await press('ArrowDown')

    expect(document.activeElement).toBe(first)
  })

  it('wraps from the first row to the last on ArrowUp', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item clickable>Two</w-item>
      <w-item clickable>Three</w-item>
    `)
    const [first, , last] = rows()
    first.focus()

    await press('ArrowUp')

    expect(document.activeElement).toBe(last)
  })

  it('jumps to the first row on Home', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item clickable>Two</w-item>
      <w-item clickable>Three</w-item>
    `)
    const [first, , last] = rows()
    last.focus()

    await press('Home')

    expect(document.activeElement).toBe(first)
  })

  it('jumps to the last row on End', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item clickable>Two</w-item>
      <w-item clickable>Three</w-item>
    `)
    const [first, , last] = rows()
    first.focus()

    await press('End')

    expect(document.activeElement).toBe(last)
  })

  it('skips a disabled row when moving focus', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item clickable disabled>Two</w-item>
      <w-item clickable>Three</w-item>
    `)
    const rowEls = rows()
    // -> A disabled row renders neither `tabindex="0"` nor `role="button"`, so it is never in the
    //    focusable set at all -- two rows, not three.
    expect(rowEls).toHaveLength(2)
    const [one, three] = rowEls
    one.focus()

    await press('ArrowDown')

    expect(document.activeElement).toBe(three)
  })

  it('skips a non-interactive row when moving focus', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item>Section label</w-item>
      <w-item clickable>Three</w-item>
    `)
    const rowEls = rows()
    expect(rowEls).toHaveLength(2)
    const [one, three] = rowEls
    one.focus()

    await press('ArrowDown')

    expect(document.activeElement).toBe(three)
  })

  it('does not move focus, or prevent the default, for a key it does not handle', async () => {
    await mountMenu(`
      <w-item clickable>One</w-item>
      <w-item clickable>Two</w-item>
    `)
    const [one] = rows()
    one.focus()

    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    panel().dispatchEvent(event)

    expect(document.activeElement).toBe(one)
    expect(event.defaultPrevented).toBe(false)
  })
})

let mountedWrappers = []
let triggerButtons = []

afterEach(() => {
  for (const wrapper of mountedWrappers) {
    wrapper.unmount()
  }
  mountedWrappers = []
  for (const button of triggerButtons) {
    button.remove()
  }
  triggerButtons = []
  document.body.innerHTML = ''
})

function mountBasicMenu(props = {}) {
  const button = document.createElement('button')
  document.body.appendChild(button)
  triggerButtons.push(button)

  const wrapper = mount(WMenu, {
    props,
    slots: { default: '<div class="menu-item">Item one</div>' },
    attachTo: button
  })
  mountedWrappers.push(wrapper)
  return { wrapper, button }
}

function body() {
  return new DOMWrapper(document.body)
}

describe('WMenu', () => {
  it('is closed until its trigger is clicked', () => {
    mountBasicMenu()

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('opens on a trigger click, rendering its content through the teleport', async () => {
    const { button } = mountBasicMenu()

    await new DOMWrapper(button).trigger('click')

    const panel = body().find('.w-menu')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Item one')
  })

  it('closes on an outside click, via its own full-screen catcher', async () => {
    const { wrapper, button } = mountBasicMenu()
    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(true)

    // -> The click-away catcher: a `fixed inset-0` div rendered just below the panel while shown.
    await body().find('.fixed.inset-0').trigger('click')

    expect(body().find('.w-menu').exists()).toBe(false)
    expect(wrapper.emitted('hide')).toBeTruthy()
  })

  it('closes on Escape', async () => {
    const { button } = mountBasicMenu()
    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('a later Escape does nothing once already closed', async () => {
    const { wrapper, button } = mountBasicMenu()
    await new DOMWrapper(button).trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(body().find('.w-menu').exists()).toBe(false)

    expect(wrapper.emitted('hide')).toHaveLength(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(wrapper.emitted('hide')).toHaveLength(1)
  })

  it('releases its Escape-stack registration on unmount while still open', async () => {
    // -> Self-contained rather than `mountBasicMenu()`: this test unmounts mid-test, and the shared
    //    `afterEach` would otherwise unmount the same wrapper a second time.
    const button = document.createElement('button')
    document.body.appendChild(button)
    const wrapper = mount(WMenu, {
      slots: { default: '<div class="menu-item">Item one</div>' },
      attachTo: button
    })
    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(true)

    wrapper.unmount()
    button.remove()

    // -> A leaked registration throws here, reaching into the unmounted instance's reactive state
    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    ).not.toThrow()
  })

  it('toggles closed on a second trigger click', async () => {
    const { button } = mountBasicMenu()

    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(true)

    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('with autoClose, dismisses itself when its own content is clicked', async () => {
    const { button } = mountBasicMenu({ autoClose: true })
    await new DOMWrapper(button).trigger('click')

    await body().find('.menu-item').trigger('click')

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('without autoClose, a click on its content does not dismiss it', async () => {
    const { button } = mountBasicMenu({ autoClose: false })
    await new DOMWrapper(button).trigger('click')

    await body().find('.menu-item').trigger('click')

    expect(body().find('.w-menu').exists()).toBe(true)
  })
})

/**
 * A native right-click is unreachable for a touch or keyboard-only user, so `context-menu` mode
 * also opens on a long-press and on Context Menu / Shift+F10. Both are scoped to that mode, leaving
 * the default click-triggered menu alone.
 */
describe('WMenu context-menu mode: keyboard trigger', () => {
  it('opens on the Context Menu key', async () => {
    const { button } = mountBasicMenu({ contextMenu: true })

    await new DOMWrapper(button).trigger('keydown', { key: 'ContextMenu' })

    expect(body().find('.w-menu').exists()).toBe(true)
  })

  it('opens on Shift+F10', async () => {
    const { button } = mountBasicMenu({ contextMenu: true })

    await new DOMWrapper(button).trigger('keydown', { key: 'F10', shiftKey: true })

    expect(body().find('.w-menu').exists()).toBe(true)
  })

  it('does not open on F10 alone, without Shift', async () => {
    const { button } = mountBasicMenu({ contextMenu: true })

    await new DOMWrapper(button).trigger('keydown', { key: 'F10' })

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('does nothing in default (click-triggered) mode', async () => {
    const { button } = mountBasicMenu()

    await new DOMWrapper(button).trigger('keydown', { key: 'ContextMenu' })

    expect(body().find('.w-menu').exists()).toBe(false)
  })
})

describe('WMenu context-menu mode: touch long-press trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function press(button, { x = 10, y = 10 } = {}) {
    button.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true
      })
    )
  }

  function move(button, { x = 10, y = 10 } = {}) {
    button.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true
      })
    )
  }

  function release(button) {
    button.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }))
  }

  it('opens after holding still past the long-press duration', async () => {
    const { button } = mountBasicMenu({ contextMenu: true })

    press(button)
    await vi.advanceTimersByTimeAsync(500)

    expect(body().find('.w-menu').exists()).toBe(true)
  })

  it('does not open on a short tap, released before the long-press duration', async () => {
    const { button } = mountBasicMenu({ contextMenu: true })

    press(button)
    await vi.advanceTimersByTimeAsync(200)
    release(button)
    await vi.advanceTimersByTimeAsync(500)

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('cancels the press when the finger moves far enough to read as a scroll', async () => {
    const { button } = mountBasicMenu({ contextMenu: true })

    press(button)
    await vi.advanceTimersByTimeAsync(200)
    move(button, { x: 50, y: 50 })
    await vi.advanceTimersByTimeAsync(500)

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('tolerates small jitter during the hold', async () => {
    const { button } = mountBasicMenu({ contextMenu: true })

    press(button)
    await vi.advanceTimersByTimeAsync(200)
    move(button, { x: 13, y: 12 })
    await vi.advanceTimersByTimeAsync(500)

    expect(body().find('.w-menu').exists()).toBe(true)
  })

  it('ignores a mouse pointer (only touch triggers a long-press)', async () => {
    const { button } = mountBasicMenu({ contextMenu: true })

    button.dispatchEvent(
      new PointerEvent('pointerdown', { pointerType: 'mouse', clientX: 10, clientY: 10 })
    )
    await vi.advanceTimersByTimeAsync(500)

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('does nothing in default (click-triggered) mode', async () => {
    const { button } = mountBasicMenu()

    press(button)
    await vi.advanceTimersByTimeAsync(500)

    expect(body().find('.w-menu').exists()).toBe(false)
  })
})
