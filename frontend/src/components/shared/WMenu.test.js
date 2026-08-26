import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'
import { h } from 'vue'

import WMenu from './WMenu.vue'

/**
 * `WMenu` teleports its panel to `document.body` and climbs from its own placeholder span to the
 * real trigger element it is nested inside (`WMenu.vue`'s `onMounted`,
 * `host.closest('button, a, .w-btn, .w-item')`) -- the same shape every real call site already has
 * (`<w-btn><w-menu>...</w-menu></w-btn>`), so a bare `<button>` wrapper reproduces it closely
 * enough for the click binding to attach to the right element.
 *
 * Unmounted after every test, same as `EditorCodeBlockMenu.test.js`'s `WMenu` suite -- that is what
 * actually detaches both the teleported DOM and the document-level `keydown`/`resize` listeners
 * `WMenu.vue` binds in `onMounted`, so one test's menu does not linger for the next.
 */
let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  document.body.innerHTML = ''
})

function mountMenu(props = {}) {
  activeWrapper = mount({
    render() {
      return h('button', { type: 'button' }, [
        'Trigger',
        h(WMenu, props, { default: () => h('div', { class: 'menu-content' }, 'Item') })
      ])
    }
  })
  return activeWrapper
}

function body() {
  return new DOMWrapper(document.body)
}

describe('WMenu', () => {
  it('is closed until the trigger is clicked, then teleports its panel open', async () => {
    const wrapper = mountMenu()

    expect(body().find('.menu-content').exists()).toBe(false)

    await wrapper.find('button').trigger('click')

    expect(body().find('[role="menu"]').exists()).toBe(true)
    expect(body().find('.menu-content').text()).toBe('Item')
  })

  it('closes on a click outside the panel, on the full-screen catcher', async () => {
    const wrapper = mountMenu()
    await wrapper.find('button').trigger('click')
    expect(body().find('.menu-content').exists()).toBe(true)

    // -> The click-away catcher: a transparent full-screen div teleported just below the panel
    await body().find('.fixed.inset-0').trigger('click')

    expect(body().find('.menu-content').exists()).toBe(false)
  })

  it('closes on Escape', async () => {
    const wrapper = mountMenu()
    await wrapper.find('button').trigger('click')
    expect(body().find('.menu-content').exists()).toBe(true)

    await body().trigger('keydown', { key: 'Escape' })

    expect(body().find('.menu-content').exists()).toBe(false)
  })

  it('leaves the panel open on a content click when auto-close is not set', async () => {
    const wrapper = mountMenu()
    await wrapper.find('button').trigger('click')

    await body().find('.menu-content').trigger('click')

    expect(body().find('.menu-content').exists()).toBe(true)
  })

  it('closes on a content click when auto-close is set', async () => {
    const wrapper = mountMenu({ autoClose: true })
    await wrapper.find('button').trigger('click')
    expect(body().find('.menu-content').exists()).toBe(true)

    await body().find('.menu-content').trigger('click')

    expect(body().find('.menu-content').exists()).toBe(false)
  })
})
