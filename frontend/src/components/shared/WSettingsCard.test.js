import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WSettingsCard from './WSettingsCard.vue'
import WSettingsRow from './WSettingsRow.vue'
import WCardHeader from './WCardHeader.vue'

/**
 * The card half of the settings pattern `AdminGeneral.vue` establishes and the other ~35 settings
 * pages adopt: a mono uppercase strip over a stack of rows, on one hairline-edged surface.
 */
describe('WSettingsCard', () => {
  it('draws the header strip over the rows, inside one WCard surface', () => {
    const wrapper = mount(WSettingsCard, {
      props: { title: 'Site info' },
      slots: { default: '<div class="a-row">a row</div>' }
    })

    const card = wrapper.find('.w-card')
    expect(card.exists()).toBe(true)
    expect(card.classes()).toContain('w-settings-card')

    const header = wrapper.find('.w-settings-card__header')
    expect(header.exists()).toBe(true)
    expect(header.text()).toBe('Site info')

    // -> Strip first, rows after: the rule under the strip is what separates the two.
    const children = [...card.element.children]
    expect(children[0]).toBe(header.element)
    expect(children[1].className).toBe('a-row')
  })

  it('renders as an h2 by default and honours a deeper level', () => {
    expect(
      mount(WSettingsCard, { props: { title: 'A' } })
        .find('h2')
        .exists()
    ).toBe(true)

    const nested = mount(WSettingsCard, { props: { title: 'A', level: 'h4' } })
    expect(nested.find('h4').exists()).toBe(true)
    expect(nested.find('h2').exists()).toBe(false)
  })

  it('takes a title slot for a heading that is more than a string', () => {
    const wrapper = mount(WSettingsCard, {
      props: { title: 'ignored' },
      slots: { title: '<span class="fancy">Site info</span>' }
    })

    expect(wrapper.find('.w-settings-card__header .fancy').text()).toBe('Site info')
    expect(wrapper.text()).not.toContain('ignored')
  })

  it('exposes a headingId that lands on the strip, so a dialog can name itself off it', () => {
    const wrapper = mount(WSettingsCard, { props: { title: 'Site info' } })

    const headingId = wrapper.vm.headingId
    expect(headingId).toBeTruthy()
    expect(wrapper.find(`#${headingId}`).classes()).toContain('w-settings-card__header')
  })

  /**
   * The round's shared-component rule: `.w-section-header` (via `WCardHeader`) is read-only for
   * this work, because 21 call sites across six other screens render it. The settings strip is a
   * second, separate treatment -- if this ever starts rendering `WCardHeader` again, the two have
   * been merged and that is a decision for whoever owns `.w-section-header`, not a quiet edit here.
   */
  it('does not render the shared section-header band', () => {
    const wrapper = mount(WSettingsCard, { props: { title: 'Site info' } })

    expect(wrapper.findComponent(WCardHeader).exists()).toBe(false)
    expect(wrapper.find('.w-section-header').exists()).toBe(false)
  })

  /**
   * Wiki #2700: the two things `WCardHeader` carries that the roll-out found a settings strip also
   * needs. Both are additive -- a card that passes neither renders exactly the strip it did before,
   * which is what the assertions above are still checking.
   */
  it('draws a hint under the title, in sentence-case body type rather than the band', () => {
    const wrapper = mount(WSettingsCard, {
      props: { title: 'Active locales' },
      slots: { hint: 'Select the locales that can be used on this site.' }
    })

    const hint = wrapper.find('.w-settings-card__hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('Select the locales that can be used on this site.')
    // -> Under the title, not beside it: the two share the strip's leading column.
    expect(wrapper.find('.w-settings-card__title').element.nextElementSibling).toBe(hint.element)
  })

  it('draws an action at the strip trailing edge', () => {
    const wrapper = mount(WSettingsCard, {
      props: { title: 'Theme' },
      slots: { action: '<button class="reset">Reset</button>' }
    })

    const action = wrapper.find('.w-settings-card__action')
    expect(action.exists()).toBe(true)
    expect(action.find('.reset').exists()).toBe(true)
  })

  it('draws neither when the card passes neither', () => {
    const wrapper = mount(WSettingsCard, { props: { title: 'Site info' } })

    expect(wrapper.find('.w-settings-card__hint').exists()).toBe(false)
    expect(wrapper.find('.w-settings-card__action').exists()).toBe(false)
  })

  it('stacks any number of rows, and each row after the first carries the rule', () => {
    const wrapper = mount(WSettingsCard, {
      props: { title: 'Features' },
      global: { components: { WSettingsRow } },
      slots: {
        default: `
          <w-settings-row label="One" />
          <w-settings-row label="Two" />
          <w-settings-row label="Three" />
        `
      }
    })

    const rows = wrapper.findAllComponents(WSettingsRow)
    expect(rows).toHaveLength(3)
    // -> The rule itself is CSS (`.w-settings-row + .w-settings-row`), measured in the real-browser
    //    suite; what is asserted here is that the rows really are adjacent siblings, which is the
    //    precondition that selector depends on.
    const elements = wrapper.findAll('.w-settings-row').map((row) => row.element)
    expect(elements[0].nextElementSibling).toBe(elements[1])
    expect(elements[1].nextElementSibling).toBe(elements[2])
  })
})
