import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WMenu from './WMenu.vue'

/*
  WMenu teleports its open panel straight into `document.body`, independent of whichever wrapper
  mounted it -- so a panel left open by one test would otherwise still be sitting there for the next
  one's `document.querySelector('.w-menu')` to pick up.
*/
afterEach(() => {
  document.body.innerHTML = ''
})

describe('WMenu', () => {
  it('renders the teleported panel with no `role` at all, not `menu` (#1641)', async () => {
    const wrapper = mount(WMenu, {
      slots: { default: '<button class="row-a">A</button><button class="row-b">B</button>' }
    })
    await wrapper.vm.show()

    const panel = document.querySelector('.w-menu')
    expect(panel).toBeTruthy()
    expect(panel.getAttribute('role')).toBeNull()
  })

  it('does not claim a `menu` role over content with no `menuitem`-family children', async () => {
    // -> The shape WItem actually renders for a clickable row: `role="button"`, never `menuitem`.
    const wrapper = mount(WMenu, {
      slots: { default: '<div role="button">Row</div>' }
    })
    await wrapper.vm.show()

    const panel = document.querySelector('.w-menu')
    expect(panel.getAttribute('role')).not.toBe('menu')
    expect(
      panel.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')
    ).toHaveLength(0)
  })
})
