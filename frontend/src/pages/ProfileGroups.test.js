import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from '@/stores/site'
import ProfileGroups from './ProfileGroups.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Task 1275: the profile Groups tab's "Other groups" section is admin-gated entirely on the backend
 * (`GET /profile/groups`'s response shape -- see that route's doc comment in `backend/api/users.ts`)
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
      groupsNone: "You're not part of any group.",
      otherGroups: "You're not part of these other {siteName} groups:"
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

    // -> Subdued per the project's opacity-60 convention (AdminApprovals.vue's disabled-rule rows),
    //    and a grey avatar rather than the member list's secondary color (AdminGroups.vue's
    //    muted-state convention) -- never hidden, since it is still informational content.
    const dimmed = wrapper.findAll('.opacity-60')
    expect(dimmed.length).toBeGreaterThan(0)
    expect(dimmed.some((el) => el.text().includes('Reviewers'))).toBe(true)

    const otherAvatar = wrapper
      .findAll('.w-avatar')
      .find((el) => el.attributes('style')?.includes('--color-grey'))
    expect(otherAvatar).toBeTruthy()

    const memberAvatar = wrapper
      .findAll('.w-avatar')
      .find((el) => el.attributes('style')?.includes('--color-secondary'))
    expect(memberAvatar).toBeTruthy()
  })
})
