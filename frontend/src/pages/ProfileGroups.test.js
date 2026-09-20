import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from '@/stores/site'
import ProfileGroups from './ProfileGroups.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * The "Other groups" section is gated entirely by `GET /profile/groups`'s response shape, not by
 * anything this component decides, so what is covered here is how it reacts to each shape: a plain
 * array versus `{ groups, otherGroups }`.
 */
function mountPage() {
  setActivePinia(createPinia())
  useSiteStore().title = 'Acme Wiki'

  const i18n = createTestI18n({
    profile: {
      groups: 'Groups',
      groupsInfo: "You're currently part of the following groups:",
      groupsLoadingFailed: 'Failed to load groups.',
      groupsMemberOf: 'Member Of',
      groupsNone: "You're not part of any group.",
      otherGroups: "You're not part of these other {siteName} groups:",
      otherGroupsTitle: 'Other Groups'
    }
  })
  return mount(ProfileGroups, {
    global: { plugins: [i18n] }
  })
}

async function flush(wrapper) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

describe('ProfileGroups: other groups section', () => {
  it('stays hidden when the response is the plain, unchanged array shape', async () => {
    globalThis.API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 'group-1', name: 'Editors' }])
    })

    const wrapper = mountPage()
    await flush(wrapper)

    expect(wrapper.text()).toContain('Editors')
    expect(wrapper.text()).not.toContain('Acme Wiki')
    expect(wrapper.vm.state.otherGroups).toStrictEqual([])
  })

  it('stays hidden when the setting is on but every group already has the caller as a member', async () => {
    globalThis.API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          groups: [{ id: 'group-1', name: 'Editors' }],
          otherGroups: []
        })
    })

    const wrapper = mountPage()
    await flush(wrapper)

    expect(wrapper.text()).not.toContain('Acme Wiki')
  })

  it('renders the subdued section when the response includes non-member groups', async () => {
    globalThis.API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          groups: [{ id: 'group-1', name: 'Editors' }],
          otherGroups: [{ id: 'group-2', name: 'Reviewers' }]
        })
    })

    const wrapper = mountPage()
    await flush(wrapper)

    expect(wrapper.text()).toContain("You're not part of these other Acme Wiki groups:")
    expect(wrapper.text()).toContain('Reviewers')

    // -> Subdued, never hidden: it is still informational content, and both lists draw the same
    //    plate, so the dimming is the whole of what distinguishes them.
    const dimmed = wrapper.findAll('.opacity-60')
    expect(dimmed.length).toBeGreaterThan(0)
    expect(dimmed.some((el) => el.text().includes('Reviewers'))).toBe(true)
    expect(dimmed.every((el) => !el.text().includes('Editors'))).toBe(true)
  })

  it('draws every membership as a settings row with a plate and no control', async () => {
    globalThis.API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          groups: [{ id: 'group-1', name: 'Editors' }],
          otherGroups: [{ id: 'group-2', name: 'Reviewers' }]
        })
    })

    const wrapper = mountPage()
    await flush(wrapper)

    const rows = wrapper.findAll('.w-settings-row')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.find('.blueprint-icon').exists()).toBe(true)
      // -> Membership is read-only, so the trailing edge is an empty `auto` control claiming no
      //    width of its own, rather than the default `grow` one reserving 200px for nothing.
      const control = row.find('.w-settings-row__control')
      expect(control.exists()).toBe(true)
      expect(control.classes()).toContain('w-settings-row__control--auto')
      expect(control.text()).toBe('')
    }

    expect(wrapper.findAll('.w-settings-card')).toHaveLength(2)
  })
})
