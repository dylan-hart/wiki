import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WChip from './WChip.vue'

import { createTestI18n } from '../../../test/i18n.js'

describe('WChip', () => {
  it('renders the label prop when no default slot content is given', () => {
    const wrapper = mount(WChip, { props: { label: 'Draft' } })

    expect(wrapper.text()).toBe('Draft')
  })

  it('prefers slot content over the label prop', () => {
    const wrapper = mount(WChip, {
      props: { label: 'Draft' },
      slots: { default: 'Published' }
    })

    expect(wrapper.text()).toBe('Published')
  })

  it('is not clickable, and has no button role, unless the clickable prop is set', async () => {
    const notClickable = mount(WChip, { props: { label: 'Tag' } })
    expect(notClickable.attributes('role')).toBeUndefined()
    await notClickable.trigger('click')
    expect(notClickable.emitted('click')).toBeUndefined()

    const clickable = mount(WChip, { props: { label: 'Tag', clickable: true } })
    expect(clickable.attributes('role')).toBe('button')
    await clickable.trigger('click')
    expect(clickable.emitted('click')).toHaveLength(1)
  })

  it('shows a remove button only when removable, and emits remove without also emitting click', async () => {
    const wrapper = mount(WChip, {
      props: { label: 'Tag', clickable: true, removable: true, removeLabel: 'Remove Tag' }
    })

    const removeBtn = wrapper.find('button[aria-label="Remove Tag"]')
    expect(removeBtn.exists()).toBe(true)

    await removeBtn.trigger('click')

    expect(wrapper.emitted('remove')).toHaveLength(1)
    // -> `@click.stop` on the remove button: it must not also bubble into the chip's own click
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  describe('i18n', () => {
    it('resolves the remove button label from the dictionary when removeLabel is not overridden', () => {
      const i18n = createTestI18n({ 'common.chip.remove': 'Entfernen' })
      const wrapper = mount(WChip, {
        props: { label: 'Tag', removable: true },
        global: { plugins: [i18n] }
      })

      expect(wrapper.find('button[aria-label="Entfernen"]').exists()).toBe(true)
    })

    it('still prefers an explicit removeLabel prop over the dictionary', () => {
      const i18n = createTestI18n({ 'common.chip.remove': 'Entfernen' })
      const wrapper = mount(WChip, {
        props: { label: 'Tag', removable: true, removeLabel: 'Drop Tag' },
        global: { plugins: [i18n] }
      })

      expect(wrapper.find('button[aria-label="Drop Tag"]').exists()).toBe(true)
      expect(wrapper.find('button[aria-label="Entfernen"]').exists()).toBe(false)
    })
  })
})
