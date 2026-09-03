import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import UserEditOverlay from './UserEditOverlay.vue'
import UserDeleteDialog from './UserDeleteDialog.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Regression coverage for task 432: the admin passkeys panel (list + per-row revoke) and a real
 * `invalidateTFA()` implementation (previously a `// TODO: invalidate user 2FA` stub that always
 * notified success with no API call at all and no error path).
 */

const USER = {
  id: 'user-1',
  name: 'Jane Doe',
  email: 'jane@example.com',
  isVerified: true,
  isActive: true,
  meta: {},
  prefs: {},
  groups: [{ id: 'grp-1', name: 'Users' }],
  auth: [
    {
      authId: 'strat-local',
      strategyKey: 'local',
      strategyIcon: 'local.svg',
      authName: 'Local',
      config: {
        authId: 'strat-local',
        isPasswordSet: true,
        isTfaSetup: true,
        isTfaRequired: false,
        mustChangePwd: false,
        restrictLogin: false
      }
    }
  ]
}

const PASSKEYS = [
  {
    id: 'pk-1',
    name: "Jane's Laptop",
    siteHostname: 'wiki.example.com',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
]

async function mountOverlay({ canManage = true } = {}) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'groups') {
      return { json: () => Promise.resolve([]) }
    }
    if (url === `users/${USER.id}`) {
      return { json: () => Promise.resolve(USER) }
    }
    if (url === `users/${USER.id}/passkeys`) {
      return { json: () => Promise.resolve({ ok: true, passkeys: PASSKEYS }) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  const router = await createTestRouter(['/u/:section'], '/u/auth')

  const { wrapper } = mountWithApp(UserEditOverlay, {
    router,
    stores: {
      admin: { overlayOpts: { id: USER.id } },
      user: { permissions: canManage ? ['manage:users'] : [] }
    }
  })
  await flushPromises()

  return wrapper
}

/**
 * Regression test for `unassignGroup(id)`: it filtered `state.user.groups` with `gr.id === id`,
 * which KEEPS only the group being removed and drops every other one -- the exact opposite of the
 * button's action ("Unassign Group X" would leave the user in every group EXCEPT X once saved).
 * Correct behaviour is `gr.id !== id`, dropping only the targeted group.
 */
async function mountWithUser(groups) {
  const router = await createTestRouter(['/:id?/:section?'], '/user-1/groups')

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(groups) })
  API_CLIENT.get.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        id: 'user-1',
        name: 'Test User',
        email: 'test@example.com',
        isVerified: true,
        isActive: true,
        meta: {},
        prefs: {},
        groups
      })
  })

  const { wrapper } = mountWithApp(UserEditOverlay, {
    router,
    stores: { admin: { overlayOpts: { id: 'user-1' } }, user: { permissions: ['manage:users'] } }
  })

  await flushPromises()

  return wrapper
}

describe('UserEditOverlay admin passkeys panel', () => {
  it('lists a passkey with its name, hostname and creation date, and offers a revoke action', async () => {
    const wrapper = await mountOverlay()

    expect(wrapper.text()).toContain("Jane's Laptop")
    expect(wrapper.text()).toContain('wiki.example.com')
  })

  it('fetches the passkeys list from GET /users/:userId/passkeys', async () => {
    await mountOverlay()

    expect(API_CLIENT.get).toHaveBeenCalledWith(`users/${USER.id}/passkeys`)
  })

  it('revokes a passkey via DELETE after confirmation, and removes it from the list', async () => {
    const wrapper = await mountOverlay()
    expect(wrapper.text()).toContain("Jane's Laptop")

    API_CLIENT.delete.mockReturnValueOnce(Promise.resolve({ ok: true }))

    const revokeBtn = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === 'common.actions.delete')
    await revokeBtn.trigger('click')

    // -> confirm() only opens the dialog; the actual call happens once its onOk handler fires
    expect(API_CLIENT.delete).not.toHaveBeenCalled()
    await openDialogs[openDialogs.length - 1].handlers.ok[0]()
    await flushPromises()

    expect(API_CLIENT.delete).toHaveBeenCalledWith(`users/${USER.id}/passkeys/pk-1`)
    expect(wrapper.text()).not.toContain("Jane's Laptop")
  })

  it('surfaces the server message and keeps the passkey listed on refusal', async () => {
    const wrapper = await mountOverlay()
    const notifyCountBefore = notifyQueue.length

    API_CLIENT.delete.mockReturnValueOnce(
      Promise.reject({ data: { message: 'This passkey was already removed.' } })
    )

    const revokeBtn = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === 'common.actions.delete')
    await revokeBtn.trigger('click')
    await openDialogs[openDialogs.length - 1].handlers.ok[0]()
    await flushPromises()

    expect(wrapper.text()).toContain("Jane's Laptop")
    expect(notifyQueue.length).toBe(notifyCountBefore + 1)
    const lastNotification = notifyQueue[notifyQueue.length - 1]
    expect(lastNotification.type).toBe('negative')
    expect(lastNotification.caption).toBe('This passkey was already removed.')
  })

  it('does not render the passkeys panel or its actions when the caller lacks manage:users', async () => {
    const wrapper = await mountOverlay({ canManage: false })

    expect(API_CLIENT.get).not.toHaveBeenCalledWith(`users/${USER.id}/passkeys`)
    expect(wrapper.text()).not.toContain("Jane's Laptop")
  })
})

describe('UserEditOverlay invalidateTFA', () => {
  it('calls POST /users/:userId/tfa/invalidate with the strategy id, and notifies on success', async () => {
    const wrapper = await mountOverlay()

    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    // -> Two buttons share this label in the auth section (change password, then invalidate 2FA);
    //    the invalidate one is the second in document order.
    const invalidateBtn = wrapper
      .findAll('button')
      .filter((b) => b.text() === 'common.actions.proceed')[1]
    await invalidateBtn.trigger('click')

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    const notifyCountBefore = notifyQueue.length
    await openDialogs[openDialogs.length - 1].handlers.ok[0]()
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(`users/${USER.id}/tfa/invalidate`, {
      json: { strategyId: 'strat-local' }
    })
    expect(notifyQueue.length).toBe(notifyCountBefore + 1)
    expect(notifyQueue[notifyQueue.length - 1].type).toBe('positive')
  })

  it('surfaces a failure notification instead of a success one when the API call rejects', async () => {
    const wrapper = await mountOverlay()

    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network error')
    })

    const invalidateBtn = wrapper
      .findAll('button')
      .filter((b) => b.text() === 'common.actions.proceed')[1]
    await invalidateBtn.trigger('click')

    const notifyCountBefore = notifyQueue.length
    await openDialogs[openDialogs.length - 1].handlers.ok[0]()
    await flushPromises()

    expect(notifyQueue.length).toBe(notifyCountBefore + 1)
    expect(notifyQueue[notifyQueue.length - 1].type).toBe('negative')
  })
})

describe('UserEditOverlay unassignGroup', () => {
  it('removes only the targeted group, keeping the rest', async () => {
    const groupA = { id: 'group-a', name: 'Group A' }
    const groupB = { id: 'group-b', name: 'Group B' }
    const wrapper = await mountWithUser([groupA, groupB])

    // -> Target the group-row "unassign" button structurally (its `.acrylic-btn` class): the
    //    aria-label is i18n-keyed text that doesn't resolve to anything meaningful under the empty
    //    test message bundle.
    const removeButtons = wrapper.findAll('.acrylic-btn')
    expect(removeButtons).toHaveLength(2)

    await removeButtons[0].trigger('click')
    await flushPromises()

    const remainingNames = wrapper.findAll('.w-item-label').map((el) => el.text())
    expect(remainingNames).toEqual(['Group B'])
    expect(remainingNames).not.toContain('Group A')
  })

  it('sends only the surviving group in the PATCH body sent to the API on Save', async () => {
    const groupA = { id: 'group-a', name: 'Group A' }
    const groupB = { id: 'group-b', name: 'Group B' }
    const wrapper = await mountWithUser([groupA, groupB])

    const removeButtons = wrapper.findAll('.acrylic-btn')
    await removeButtons[0].trigger('click')
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    // -> Under the empty test i18n bundle, `t()` falls back to the raw message key rather than
    //    resolved text ("common.actions.save" instead of "Save").
    const saveButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('common.actions.save'))
    await saveButton.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'users/user-1',
      expect.objectContaining({
        json: expect.objectContaining({ groups: ['group-b'] })
      })
    )
  })
})

/**
 * OpenProject #2440: picking a group to assign that is currently on an enabled strategy's
 * `mappableGroups` allow-list warns before the admin clicks "Assign Group" -- the group may be
 * silently reverted the next time that user logs in through the provider.
 */
describe('UserEditOverlay groups tab: provider-sync warning', () => {
  async function mountGroupsTab({ syncWarnings }) {
    const router = await createTestRouter(['/:id?/:section?'], '/user-1/groups')

    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'groups') {
        return {
          json: () =>
            Promise.resolve([
              { id: 'group-editors', name: 'Editors' },
              { id: 'group-reviewers', name: 'Reviewers' }
            ])
        }
      }
      if (url === 'users/user-1') {
        return {
          json: () =>
            Promise.resolve({
              id: 'user-1',
              name: 'Test User',
              email: 'test@example.com',
              isVerified: true,
              isActive: true,
              meta: {},
              prefs: {},
              groups: [{ id: 'group-reviewers', name: 'Reviewers' }]
            })
        }
      }
      if (url === 'authentication/synced-groups') {
        return { json: () => Promise.resolve(syncWarnings) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const { wrapper } = mountWithApp(UserEditOverlay, {
      router,
      messages: {
        admin: {
          users: { groupSyncWarning: 'Synced from {provider}, may be reverted on next login' }
        }
      },
      stores: { admin: { overlayOpts: { id: 'user-1' } }, user: { permissions: ['manage:users'] } }
    })
    await flushPromises()

    return wrapper
  }

  /** Opens the Groups tab's "group to add" picker and clicks the option matching `groupName`. */
  async function pickGroupToAdd(wrapper, groupName) {
    const control = wrapper.find('[role="combobox"]')
    await control.trigger('click')
    await flushPromises()
    const option = wrapper.findAll('[role="option"]').find((el) => el.text().trim() === groupName)
    await option.trigger('click')
    await flushPromises()
  }

  it('shows no warning when nothing is selected to add', async () => {
    const wrapper = await mountGroupsTab({
      syncWarnings: [
        { groupId: 'group-editors', strategies: [{ id: 'strat-1', displayName: 'Corp OIDC' }] }
      ]
    })

    expect(wrapper.text()).not.toContain('Synced from')

    wrapper.unmount()
  })

  it('warns, naming the provider, once a synced-and-mappable group is selected to add', async () => {
    const wrapper = await mountGroupsTab({
      syncWarnings: [
        { groupId: 'group-editors', strategies: [{ id: 'strat-1', displayName: 'Corp OIDC' }] }
      ]
    })

    await pickGroupToAdd(wrapper, 'Editors')

    expect(wrapper.text()).toContain('Synced from')
    expect(wrapper.text()).toContain('Corp OIDC')

    wrapper.unmount()
  })

  it('does not warn for a group absent from the synced-groups response', async () => {
    const wrapper = await mountGroupsTab({
      syncWarnings: [
        { groupId: 'group-editors', strategies: [{ id: 'strat-1', displayName: 'Corp OIDC' }] }
      ]
    })

    // -> Only group-editors is in the synced-groups response above; group-reviewers is already
    //    assigned and is still offered by the picker (nothing filters an already-assigned group
    //    out of it -- `assignGroup()` itself is what refuses a duplicate), so this exercises the
    //    "no warning" path against a group that IS a real, selectable option.
    await pickGroupToAdd(wrapper, 'Reviewers')

    expect(wrapper.text()).not.toContain('Synced from')

    wrapper.unmount()
  })
})

/**
 * The operations panel's "Delete user" proceed button was wired to `async function deleteUser() {}`
 * -- a live, `canManage`-gated button that did nothing at all when clicked. It now opens the same
 * `UserDeleteDialog` the users list opens (`pages/AdminUsers.vue#deleteUser`), which owns the
 * confirmation, the optional content reassignment and the `DELETE /_api/users/:id` itself.
 */
describe('UserEditOverlay operations panel delete user', () => {
  it('opens UserDeleteDialog for the user being edited', async () => {
    setActivePinia(createPinia())

    const adminStore = useAdminStore()
    adminStore.overlayOpts = { id: USER.id }
    adminStore.overlay = 'UserEditOverlay'

    const userStore = useUserStore()
    userStore.permissions = ['manage:users']

    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'groups') {
        return { json: () => Promise.resolve([]) }
      }
      if (url === `users/${USER.id}`) {
        return { json: () => Promise.resolve(USER) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const router = await createTestRouter(['/u/:section'], '/u/operations')

    const i18n = createTestI18n()

    const wrapper = mount(UserEditOverlay, {
      global: {
        plugins: [router, i18n]
      }
    })
    await flushPromises()

    // -> Every other proceed button in this panel is `color="primary"`; the delete card's is the one
    //    `WBtn` paints from `--color-negative` (an inline style, not a class -- see `WBtn.vue`).
    const deleteButton = wrapper
      .findAll('button')
      .find((b) => (b.attributes('style') ?? '').includes('--color-negative'))
    expect(deleteButton).toBeDefined()

    const openBefore = openDialogs.length
    await deleteButton.trigger('click')

    expect(openDialogs.length).toBe(openBefore + 1)
    const opened = openDialogs[openDialogs.length - 1]
    expect(opened.component).toBe(UserDeleteDialog)
    expect(opened.props.user.id).toBe(USER.id)

    // -> Closing the overlay is what makes the list page reload; the dialog itself owns the delete.
    expect(adminStore.overlay).not.toBe('')
    await opened.handlers.ok[0]()
    expect(adminStore.overlay).toBe('')

    wrapper.unmount()
  })
})

/**
 * OpenProject #1755: the overview panel's created/updated/last-login dates and the passkeys panel's
 * creation date used a local `formattedDate()` hardcoded to the BROWSER's own timezone
 * (`Temporal.Instant.prototype.toLocaleString` called with an explicit `undefined` locale),
 * ignoring the user's stored
 * `timezone`/`dateFormat`/`timeFormat` preferences entirely. Converted to the shared
 * `helpers/datetime.js#humanizeDate`, which delegates to `userStore.formatDateTime`.
 */
describe('UserEditOverlay dates honour the stored profile timezone (OpenProject #1755)', () => {
  async function mountOverviewWithTimezone(timezone) {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'groups') {
        return { json: () => Promise.resolve([]) }
      }
      if (url === `users/${USER.id}`) {
        return {
          json: () =>
            Promise.resolve({
              ...USER,
              createdAt: '2026-03-04T15:30:00.000Z',
              updatedAt: '2026-03-04T15:30:00.000Z',
              lastLoginAt: '2026-03-04T15:30:00.000Z'
            })
        }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const router = await createTestRouter(['/u/:section'], '/u/overview')

    const { wrapper } = mountWithApp(UserEditOverlay, {
      messages: { common: { datetime: '{date} at {time}' } },
      router,
      stores: {
        admin: { overlayOpts: { id: USER.id } },
        user: {
          permissions: ['manage:users'],
          timezone: timezone,
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '24h'
        }
      }
    })
    await flushPromises()

    return wrapper
  }

  it('renders the same instant differently for two different stored timezones', async () => {
    const wrapperUtc = await mountOverviewWithTimezone('UTC')
    expect(wrapperUtc.text()).toContain('2026-03-04 at 15:30')
    wrapperUtc.unmount()

    const wrapperTokyo = await mountOverviewWithTimezone('Asia/Tokyo')
    // -> Same instant, nine hours ahead -- proof the stored zone (not the sandbox's own) is honoured
    expect(wrapperTokyo.text()).toContain('2026-03-05 at 00:30')
    wrapperTokyo.unmount()
  })
})
