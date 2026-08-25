import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WMenu from './WMenu.vue'

/**
 * OpenProject #1648: Up/Down/Home/End roving focus between `WMenu` rows.
 *
 * `WMenu` is mounted `modelValue: true` (controlled) so it shows immediately on mount rather than
 * needing a trigger climbed/clicked first -- see `onMounted`'s `if (props.modelValue === true) {
 * show() }`. Its `role="menu"` panel only exists in the DOM once shown, so every assertion below
 * queries `document` rather than `wrapper` (the panel is teleported to `body`, outside the mounted
 * subtree `@vue/test-utils` tracks).
 */
async function mountMenu(slotHtml) {
  const wrapper = mount(WMenu, {
    props: { modelValue: true },
    attachTo: document.body,
    slots: { default: slotHtml }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

function panel() {
  return document.querySelector('[role="menu"]')
}

function rows() {
  return [...document.querySelectorAll('.w-menu [role="button"], .w-menu a[href]')]
}

async function press(key) {
  panel().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('WMenu roving focus', () => {
  afterEach(() => {
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
    // -> The disabled row renders neither `tabindex="0"` nor `role="button"`, so it never appears
    //    in the focusable set at all -- two rows found, not three.
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
