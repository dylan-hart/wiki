import { describe, expect, it } from 'vitest'

import ProfileVisibilityToggle from './ProfileVisibilityToggle.vue'
import { mountWithApp } from '../../test/mount.js'

function mountToggle(props) {
  return mountWithApp(ProfileVisibilityToggle, {
    props: { field: 'location', fieldLabel: 'Location', ...props },
    messages: {
      profile: {
        publicToggle: 'Visible to other users',
        publicToggleAria: '{visibility}: {field}',
        publicToggleForced: 'An administrator has made this always visible.'
      }
    }
  }).wrapper
}

describe('ProfileVisibilityToggle', () => {
  it('names the switch by the visible text and the field it belongs to', () => {
    const wrapper = mountToggle({})

    const button = wrapper.find('button[role="switch"]')
    expect(button.attributes('aria-label')).toBe('Visible to other users: Location')
    expect(wrapper.text()).toContain('Visible to other users')
  })

  it('emits the new value when an unforced toggle is clicked', async () => {
    const wrapper = mountToggle({ modelValue: false })

    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('shows on, locked and explained when forced, whatever the model says', async () => {
    const wrapper = mountToggle({ modelValue: false, forced: true })

    const button = wrapper.find('button')
    expect(button.attributes('aria-checked')).toBe('true')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-describedby')).toBe('profile-public-forced-location')
    expect(wrapper.find('#profile-public-forced-location').text()).toBe(
      'An administrator has made this always visible.'
    )

    await button.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('draws no explanation when not forced', () => {
    const wrapper = mountToggle({ modelValue: true })

    expect(wrapper.find('[data-testid="profile-public-forced-location"]').exists()).toBe(false)
    expect(wrapper.find('button').attributes('aria-describedby')).toBeUndefined()
  })
})
