import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import WMenu from './WMenu.vue'

/**
 * `WMenu` renders its panel behind a `<teleport to="body">`, same as `WDialog` -- see that file's
 * test for the same `DOMWrapper(document.body)` pattern this one reuses.
 *
 * It resolves its own trigger element by climbing from a hidden placeholder to the nearest
 * `button, a, .w-btn, .w-item` ancestor (`onMounted`), which is why every test here mounts against a
 * real `<button>` via `attachTo` rather than a bare container -- that is the shape every real call
 * site (`<w-btn><w-menu>...</w-menu></w-btn>`) actually provides.
 */

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

function mountMenu(props = {}) {
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
    mountMenu()

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('opens on a trigger click, rendering its content through the teleport', async () => {
    const { button } = mountMenu()

    await new DOMWrapper(button).trigger('click')

    const panel = body().find('.w-menu')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Item one')
  })

  it('closes on an outside click, via its own full-screen catcher', async () => {
    const { wrapper, button } = mountMenu()
    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(true)

    // -> The click-away catcher: a `fixed inset-0` div rendered just below the panel while shown.
    await body().find('.fixed.inset-0').trigger('click')

    expect(body().find('.w-menu').exists()).toBe(false)
    expect(wrapper.emitted('hide')).toBeTruthy()
  })

  it('closes on Escape', async () => {
    const { button } = mountMenu()
    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('toggles closed on a second trigger click', async () => {
    const { button } = mountMenu()

    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(true)

    await new DOMWrapper(button).trigger('click')
    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('with autoClose, dismisses itself when its own content is clicked', async () => {
    const { button } = mountMenu({ autoClose: true })
    await new DOMWrapper(button).trigger('click')

    await body().find('.menu-item').trigger('click')

    expect(body().find('.w-menu').exists()).toBe(false)
  })

  it('without autoClose, a click on its content does not dismiss it', async () => {
    const { button } = mountMenu({ autoClose: false })
    await new DOMWrapper(button).trigger('click')

    await body().find('.menu-item').trigger('click')

    expect(body().find('.w-menu').exists()).toBe(true)
  })
})
