import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from '@/stores/site'
import ProfileGroups from './ProfileGroups.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Task 1275: the profile Groups tab's "Other groups" section is admin-gated entirely on the backend
 * (`GET /profile/groups`'s response shape -- see that route's doc comment in `backend/api/users/profile.ts`)
 * rather than on anything this component decides for itself, so what is tested here is purely how the
 * component reacts to each response shape: a plain array (the section stays absent) versus
 * `{ groups, otherGroups }` (the section renders, subdued).
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

    // -> Subdued per the project's opacity-60 convention (AdminApprovals.vue's disabled-rule rows)
    //    -- never hidden, since it is still informational content. On the CARD since #2701: a
    //    settings row is one component rather than the pair of sections that used to carry the
    //    class each, and both lists now draw the same 34px plate, so the dimming is the whole of
    //    what distinguishes them.
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
      // -> Membership is read-only: the trailing edge is an empty `auto` control, which claims no
      //    width of its own, rather than the default `grow` one that would reserve 200px for
      //    nothing. That the row renders correctly with an empty control is the shape #2701 was
      //    asked to confirm the shared row already supports.
      const control = row.find('.w-settings-row__control')
      expect(control.exists()).toBe(true)
      expect(control.classes()).toContain('w-settings-row__control--auto')
      expect(control.text()).toBe('')
    }

    expect(wrapper.findAll('.w-settings-card')).toHaveLength(2)
  })
})
