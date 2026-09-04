import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import GroupUsersPanel from './GroupUsersPanel.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2440: this panel is the other direction of the group-assignment warning -- adding a
 * user to a group that is itself on an enabled strategy's `mappableGroups` allow-list. Unlike
 * `UserEditOverlay.vue`'s per-selection warning, this one is per-group and shown as soon as the
 * panel mounts, since `groupId` (and therefore whether it is synced) never changes while the panel
 * is open.
 */

async function mountPanel({ groupId = 'group-editors', syncWarnings = [] } = {}) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === `groups/${groupId}/users`) {
      return { json: () => Promise.resolve({ users: [], total: 0 }) }
    }
    if (url === 'authentication/synced-groups') {
      return { json: () => Promise.resolve(syncWarnings) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  const { wrapper } = mountWithApp(GroupUsersPanel, {
    props: { groupId, canManage: true },
    messages: {
      admin: {
        groups: {
          syncWarning: 'Synced from {provider}, may be reverted on next login',
          usersNone: 'No users are assigned to this group yet.'
        }
      }
    }
  })
  await flushPromises()

  return wrapper
}

describe('GroupUsersPanel empty state (OpenProject #2061)', () => {
  it("renders the table's #no-data slot message when the group has no members", async () => {
    const wrapper = await mountPanel({ groupId: 'group-editors', syncWarnings: [] })

    expect(wrapper.text()).toContain('No users are assigned to this group yet.')

    wrapper.unmount()
  })
})

describe('GroupUsersPanel provider-sync warning', () => {
  it('shows nothing for a group not on any strategy’s allow-list', async () => {
    const wrapper = await mountPanel({ groupId: 'group-editors', syncWarnings: [] })

    expect(wrapper.text()).not.toContain('Synced from')

    wrapper.unmount()
  })

  it('warns, naming every strategy, for a group the response names', async () => {
    const wrapper = await mountPanel({
      groupId: 'group-editors',
      syncWarnings: [
        {
          groupId: 'group-editors',
          strategies: [
            { id: 'strat-1', displayName: 'Corp OIDC' },
            { id: 'strat-2', displayName: 'Directory LDAP' }
          ]
        }
      ]
    })

    expect(wrapper.text()).toContain('Synced from')
    expect(wrapper.text()).toContain('Corp OIDC')
    expect(wrapper.text()).toContain('Directory LDAP')

    wrapper.unmount()
  })

  it('does not warn for a different group present in the response', async () => {
    const wrapper = await mountPanel({
      groupId: 'group-reviewers',
      syncWarnings: [
        { groupId: 'group-editors', strategies: [{ id: 'strat-1', displayName: 'Corp OIDC' }] }
      ]
    })

    expect(wrapper.text()).not.toContain('Synced from')

    wrapper.unmount()
  })

  it('fails silently (no warning, no crash) when the synced-groups request itself rejects', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'groups/group-editors/users') {
        return { json: () => Promise.resolve({ users: [], total: 0 }) }
      }
      if (url === 'authentication/synced-groups') {
        return { json: () => Promise.reject(new Error('forbidden')) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const { wrapper } = mountWithApp(GroupUsersPanel, {
      props: { groupId: 'group-editors', canManage: true }
    })
    await flushPromises()

    expect(wrapper.text()).not.toContain('Synced from')

    wrapper.unmount()
  })
})
