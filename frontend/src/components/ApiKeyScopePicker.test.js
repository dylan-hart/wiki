import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ApiKeyScopePicker from './ApiKeyScopePicker.vue'

/**
 * A small, deterministic scope set standing in for `API_KEY_SCOPES` (task #1272): two verbs, one of
 * them ('review') with a single member -- exactly the shape the real vocabulary's own `review` verb
 * has -- so a single-item group is covered without depending on the full real list's size.
 */
const SCOPES = ['manage:users', 'manage:groups', 'read:pages', 'review:pages']

function mountPicker(props = {}) {
  return mount(ApiKeyScopePicker, {
    props: { modelValue: [], scopes: SCOPES, ...props }
  })
}

/** Group header row -- a `w-checkbox` (`role="checkbox"`) plus a toggle button labelled by verb. */
function groupCheckbox(wrapper, verb) {
  return wrapper.find(`[role="checkbox"][aria-label="${verb}"]`)
}

function groupToggle(wrapper, verb) {
  return [...wrapper.findAll('.api-key-scope-picker__group-toggle')].find((btn) =>
    btn.text().startsWith(verb)
  )
}

function leafCheckbox(wrapper, scope) {
  return [...wrapper.findAll('[role="checkbox"]')].find((el) => el.text().includes(scope))
}

describe('ApiKeyScopePicker', () => {
  it('renders one group per verb, including a single-member group', () => {
    const wrapper = mountPicker()

    expect(groupCheckbox(wrapper, 'manage').exists()).toBe(true)
    expect(groupCheckbox(wrapper, 'read').exists()).toBe(true)
    expect(groupCheckbox(wrapper, 'review').exists()).toBe(true)
    expect(wrapper.findAll('.api-key-scope-picker__group')).toHaveLength(3)
  })

  it('groups start collapsed, and a click on the group toggle reveals its scopes', async () => {
    const wrapper = mountPicker()
    const manageBody = wrapper.findAll('.api-key-scope-picker__scopes')[0]

    expect(manageBody.attributes('style')).toContain('display: none')

    await groupToggle(wrapper, 'manage').trigger('click')

    expect(manageBody.attributes('style') ?? '').not.toContain('display: none')
    expect(manageBody.text()).toContain('manage:users')
    expect(manageBody.text()).toContain('manage:groups')

    await groupToggle(wrapper, 'manage').trigger('click')
    expect(manageBody.attributes('style')).toContain('display: none')
  })

  it('reports none/mixed/all group state via the tri-state group checkbox', async () => {
    const none = mountPicker({ modelValue: [] })
    expect(groupCheckbox(none, 'manage').attributes('aria-checked')).toBe('false')

    const mixed = mountPicker({ modelValue: ['manage:users'] })
    expect(groupCheckbox(mixed, 'manage').attributes('aria-checked')).toBe('mixed')

    const all = mountPicker({ modelValue: ['manage:users', 'manage:groups'] })
    expect(groupCheckbox(all, 'manage').attributes('aria-checked')).toBe('true')
  })

  it('toggling an individual scope checkbox adds or removes just that scope', async () => {
    const wrapper = mountPicker({ modelValue: ['manage:users'] })
    await groupToggle(wrapper, 'manage').trigger('click')

    await leafCheckbox(wrapper, 'manage:groups').trigger('click')
    expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual([
      'manage:users',
      'manage:groups'
    ])
  })

  it('clicking a none/mixed group checkbox selects every scope in that group', async () => {
    const wrapper = mountPicker({ modelValue: ['manage:users', 'read:pages'] })

    await groupCheckbox(wrapper, 'manage').trigger('click')

    expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual(
      expect.arrayContaining(['read:pages', 'manage:users', 'manage:groups'])
    )
    expect(wrapper.emitted('update:modelValue').at(-1)[0]).toHaveLength(3)
  })

  it('clicking a fully-checked group checkbox deselects every scope in that group', async () => {
    const wrapper = mountPicker({ modelValue: ['manage:users', 'manage:groups', 'read:pages'] })

    await groupCheckbox(wrapper, 'manage').trigger('click')

    expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual(['read:pages'])
  })
})
