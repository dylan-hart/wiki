import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { fileOpen } from 'browser-fs-access'

import GroupEditOverlay from './GroupEditOverlay.vue'
import UserSearchDialog from './UserSearchDialog.vue'
import WConfirmDialog from './shared/WConfirmDialog.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

vi.mock('browser-fs-access', () => ({
  fileOpen: vi.fn(),
  fileSave: vi.fn()
}))

/**
 * A held role renders as a chip labelled with its catalog `title`, so a permission string missing
 * from (or misspelled in) the rule catalog renders no chip or a blank one rather than this text --
 * which is what asserting on the titles proves.
 */
const SITE_PERMISSION_TITLES = {
  'site:general': 'Site: General Settings',
  'site:theme': 'Site: Theme',
  'site:navigation': 'Site: Navigation',
  'site:blocks': 'Site: Blocks',
  'site:approvals': 'Site: Approval Rules',
  'site:login': 'Site: Login & Authentication',
  'site:locale': 'Site: Locale',
  'site:editors': 'Site: Editors',
  'site:templates': 'Site: Page Templates'
}

async function mountRulesSection(groupId) {
  API_CLIENT.get.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        id: groupId,
        name: 'Test Group',
        userCount: 0,
        permissions: [],
        rules: [
          {
            id: 'rule-1',
            name: 'Site admin rule',
            mode: 'ALLOW',
            roles: Object.keys(SITE_PERMISSION_TITLES),
            sites: [],
            match: 'START',
            path: '',
            locales: []
          }
        ]
      })
  })

  const router = await createTestRouter(['/:section'], `/rules`)

  // -> The catalog resolves its titles through `t()`, so the bundle must carry those keys or the
  //    chip renders the raw untranslated key.
  const { wrapper } = mountWithApp(GroupEditOverlay, {
    messages: Object.fromEntries(
      Object.entries(SITE_PERMISSION_TITLES).map(([permission, title]) => [
        `admin.groups.permissions.${permission}.title`,
        title
      ])
    ),
    router,
    stores: { admin: { overlayOpts: { id: groupId }, sites: [], locales: [] } }
  })

  await flushPromises()

  return wrapper
}

async function mountWithGroup() {
  const router = await createTestRouter(['/:id?/:section?'], '/group-1/users')

  // -> Real strings rather than the raw keys an empty bundle falls back to: the assertions read the
  //    interpolated text (the failing user's name, the pluralized success count).

  // -> Mock order is load-bearing: `onMounted()` runs `checkRoute()` before `fetchGroup()`, and on
  //    the `users` section `checkRoute()` issues `refreshUsers()`'s GET synchronously first.
  API_CLIENT.get.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        users: [{ id: 'user-1', name: 'Existing User', email: 'existing@example.com' }],
        total: 1
      })
  })
  API_CLIENT.get.mockReturnValueOnce({
    json: () => Promise.resolve({ id: 'group-1', name: 'Test Group', userCount: 1, rules: [] })
  })

  const { wrapper } = mountWithApp(GroupEditOverlay, {
    messages: {
      admin: {
        groups: {
          assignUserFailed: 'Failed to assign {userName} to this group.',
          assignUserSuccess:
            'User was assigned to the group successfully. | {count} users were assigned to the group successfully.'
        }
      }
    },
    router,
    stores: { admin: { overlayOpts: { id: 'group-1' } }, user: { permissions: ['manage:groups'] } }
  })

  await flushPromises()

  return wrapper
}

// The upstream docs these buttons linked to describe upstream's classic RBAC model, not this
// fork's three permission kinds, and no accurate fork-specific target exists to point at instead.
describe('GroupEditOverlay: fork-mismatched permission-model help links removed', () => {
  it('renders no help link on the rules or users sections', async () => {
    const rulesWrapper = await mountRulesSection('11111111-1111-4111-8111-111111111111')
    expect(rulesWrapper.find('a[href*="/admin/permissions#rules"]').exists()).toBe(false)

    const usersWrapper = await mountWithGroup()
    expect(usersWrapper.find('a[href*="/admin/groups#users"]').exists()).toBe(false)
  })

  it('renders no help link on the permissions section', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'group-perms',
          name: 'Test Group',
          userCount: 0,
          permissions: [],
          rules: []
        })
    })

    const router = await createTestRouter(['/:section'], '/permissions')

    const { wrapper } = mountWithApp(GroupEditOverlay, {
      router,
      stores: { admin: { overlayOpts: { id: 'group-perms' }, sites: [], locales: [] } }
    })
    await flushPromises()

    expect(wrapper.find('a[href*="/admin/permissions#system-permissions"]').exists()).toBe(false)
  })
})

describe('GroupEditOverlay rule editor: site: permission vocabulary', () => {
  it('renders every site: permission held by a rule with its catalog title', async () => {
    const wrapper = await mountRulesSection('11111111-1111-4111-8111-111111111111')

    const text = wrapper.text()
    for (const title of Object.values(SITE_PERMISSION_TITLES)) {
      expect(text).toContain(title)
    }
  })
})

// The mounted hint is deliberately unlike anything a catalog literal could hold, so rendering it
// proves the hint is read from the dictionary rather than from the catalog array.
describe('GroupEditOverlay global permissions: hint resolves from the i18n dictionary', () => {
  it("renders a permission row's hint from a mounted translation, not a literal", async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'group-perms',
          name: 'Test Group',
          userCount: 0,
          permissions: [],
          rules: []
        })
    })

    const router = await createTestRouter(['/:section'], '/permissions')

    const dictionaryHint = 'DICTIONARY-SOURCED HINT TEXT, NOT A COMPONENT LITERAL'

    const { wrapper } = mountWithApp(GroupEditOverlay, {
      messages: {
        'admin.groups.permissions.access:admin.hint': dictionaryHint
      },
      router,
      stores: { admin: { overlayOpts: { id: 'group-perms' } } }
    })

    await flushPromises()

    expect(wrapper.text()).toContain(dictionaryHint)
  })
})

// A permission the API enforces but the rule catalog omits is grantable only by hand-crafting rule
// JSON, so the catalog's coverage is what this guards.
describe('GroupEditOverlay rule editor: manage:classification permission', () => {
  async function mountWithClassificationPermissionRule() {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'group-manage-classification',
          name: 'Test Group',
          userCount: 0,
          permissions: [],
          rules: [
            {
              id: 'rule-1',
              name: 'Declassify rule',
              mode: 'ALLOW',
              roles: ['write:pages', 'manage:classification'],
              sites: [],
              match: 'START',
              path: '',
              locales: []
            }
          ]
        })
    })

    const router = await createTestRouter(['/:section'], '/rules')

    const { wrapper } = mountWithApp(GroupEditOverlay, {
      messages: {
        'admin.groups.permissions.manage:classification.title': 'Manage Classification'
      },
      router,
      stores: {
        admin: { overlayOpts: { id: 'group-manage-classification' }, sites: [], locales: [] }
      }
    })

    await flushPromises()

    return wrapper
  }

  it('renders a rule holding manage:classification with its catalog title', async () => {
    const wrapper = await mountWithClassificationPermissionRule()

    expect(wrapper.text()).toContain('Manage Classification')
  })
})

// START/END/EXACT compare `path` against a page path, which is always stored lowercased, so an
// uppercase character would save a rule that can never match -- silently, for a DENY.
describe('GroupEditOverlay rule editor: path case-folding (OpenProject #2182)', () => {
  it('lowercases what is typed into the path field for a START rule', async () => {
    const wrapper = await mountRulesSection('22222222-2222-4222-8222-222222222222')

    const input = wrapper.find('[aria-label="admin.groups.rulePath"]')
    await input.setValue('HR/Salaries')

    expect(input.element.value).toBe('hr/salaries')
  })
})

describe('GroupEditOverlay assignUser partial failure', () => {
  it('assigns the successes, reports the failure by name+reason, and refetches true membership', async () => {
    const wrapper = await mountWithGroup()

    // -> `assignUser` is absent from this test's i18n bundle, so `t()` falls back to the raw key.
    const assignButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('admin.groups.assignUser') && !b.text().includes('Title'))
    expect(assignButton).toBeTruthy()
    await assignButton.trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].component).toBe(UserSearchDialog)
    const dialogId = openDialogs[0].id

    const userTwo = { id: 'user-2', name: 'User Two' }
    const userThree = { id: 'user-3', name: 'User Three' }
    const userFour = { id: 'user-4', name: 'User Four' }

    // -> Every server-side refusal reaches the client the same way: a rejected `.json()` carrying
    //    `{ data: { message } }`, which is what `apiErrorMessage()` reads.
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.post.mockReturnValueOnce({
      json: () => {
        const err = new Error('Conflict')
        err.data = { message: 'User is already assigned to this group.' }
        return Promise.reject(err)
      }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    // -> The post-batch `refreshUsers()` response: server-truth membership, deliberately not the
    //    dialog's payload, so an optimistic client-side splice would fail the row assertions below.
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [
            { id: 'user-1', name: 'Existing User', email: 'existing@example.com' },
            { id: 'user-2', name: 'User Two', email: 'two@example.com' },
            { id: 'user-4', name: 'User Four', email: 'four@example.com' }
          ],
          total: 3
        })
    })

    notifyQueue.splice(0)
    // -> `WDialogHost` relays a dialog's `@ok` as exactly this call, so driving it directly is a
    //    faithful stand-in for a multi-select without mounting `UserSearchDialog`'s own search UI.
    closeDialog(dialogId, true, [userTwo, userThree, userFour])
    await flushPromises()
    await flushPromises()
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(3)
    expect(API_CLIENT.post).toHaveBeenNthCalledWith(1, 'groups/group-1/users/user-2')
    expect(API_CLIENT.post).toHaveBeenNthCalledWith(2, 'groups/group-1/users/user-3')
    expect(API_CLIENT.post).toHaveBeenNthCalledWith(3, 'groups/group-1/users/user-4')

    const failureToasts = notifyQueue.filter((n) => n.type === 'negative')
    expect(failureToasts).toHaveLength(1)
    expect(failureToasts[0].message).toBe('Failed to assign User Three to this group.')
    expect(failureToasts[0].caption).toBe('User is already assigned to this group.')

    const successToasts = notifyQueue.filter((n) => n.type === 'positive')
    expect(successToasts).toHaveLength(1)
    expect(successToasts[0].message).toBe('2 users were assigned to the group successfully.')

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'groups/group-1/users',
      expect.objectContaining({ searchParams: expect.any(Object) })
    )
    const names = wrapper.findAll('td').map((td) => td.text())
    expect(names.join(' ')).toContain('User Two')
    expect(names.join(' ')).toContain('User Four')
    expect(names.join(' ')).not.toContain('User Three')
  })
})

/**
 * A group's `permissions` column may still carry page-permission strings that `GlobalPermission#`
 * rejects, so resending an untouched field is a 400 on any save at all -- which is why `save()`
 * diffs against the last-fetched snapshot instead of PUTting the whole group.
 */
describe('GroupEditOverlay save(): diff-and-send (OpenProject #2555)', () => {
  // -> Page-permission strings `PUT /groups/:groupId`'s schema rejects: resending them is a 400.
  const STALE_PERMISSIONS = ['read:pages', 'read:assets', 'read:comments']

  async function mountOverview(groupId) {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: groupId,
          name: 'Legacy Group',
          userCount: 0,
          redirectOnLogin: '',
          redirectOnFirstLogin: '',
          redirectOnLogout: '',
          permissions: STALE_PERMISSIONS,
          rules: [
            {
              id: 'rule-1',
              name: 'Default Rule',
              roles: ['read:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        })
    })

    const router = await createTestRouter(['/:section'], '/overview')

    const { wrapper } = mountWithApp(GroupEditOverlay, {
      router,
      stores: {
        admin: { overlayOpts: { id: groupId }, sites: [], locales: [] },
        user: { permissions: ['manage:groups'] }
      }
    })

    await flushPromises()

    return wrapper
  }

  function findSaveButton(wrapper) {
    return wrapper.findAll('button').find((b) => b.text().includes('common.actions.save'))
  }

  it('PUTs only the field the admin actually changed, not the stale legacy permissions along with it', async () => {
    const wrapper = await mountOverview('legacy-group-1')

    const nameInput = wrapper.find('[aria-label="admin.groups.name"]')
    expect(nameInput.exists()).toBe(true)
    await nameInput.setValue('Renamed Group')

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const saveButton = findSaveButton(wrapper)
    expect(saveButton).toBeTruthy()
    await saveButton.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.put).toHaveBeenCalledWith('groups/legacy-group-1', {
      json: { name: 'Renamed Group' }
    })
  })

  it('sends no PUT at all when nothing was changed', async () => {
    const wrapper = await mountOverview('legacy-group-2')

    const saveButton = findSaveButton(wrapper)
    await saveButton.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('a second save in the same session diffs against the just-saved state, not the original fetch', async () => {
    const wrapper = await mountOverview('legacy-group-3')

    const nameInput = wrapper.find('[aria-label="admin.groups.name"]')
    await nameInput.setValue('First Rename')
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await findSaveButton(wrapper).trigger('click')
    await flushPromises()

    // -> Saving again with no further edits must not resend `name` (already reflected in the
    //    snapshot) or the untouched, stale `permissions`.
    await findSaveButton(wrapper).trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
  })
})

describe('GroupEditOverlay unassignUser confirmation', () => {
  it('opens a negative-coloured, delete-labelled confirmation', async () => {
    const wrapper = await mountWithGroup()

    const unassignBtn = wrapper.find('[aria-label="admin.groups.unassignUser"]')
    expect(unassignBtn.exists()).toBe(true)
    await unassignBtn.trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props.color).toBe('negative')
    expect(openDialogs[0].props.cancel).toBe(true)
    expect(openDialogs[0].props.okLabel).toBe('common.actions.delete')

    closeDialog(openDialogs[0].id, false)
  })
})

describe('GroupEditOverlay rule editor: CLASSIFICATION match kind', () => {
  async function mountWithClassificationRule() {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'group-classification',
          name: 'Test Group',
          userCount: 0,
          permissions: [],
          rules: [
            {
              id: 'rule-1',
              name: 'Internal-only rule',
              mode: 'DENY',
              roles: ['read:pages'],
              sites: [],
              match: 'CLASSIFICATION',
              path: '',
              locales: [],
              classifications: ['level-internal']
            }
          ]
        })
    })

    const router = await createTestRouter(['/:section'], '/rules')

    const { wrapper } = mountWithApp(GroupEditOverlay, {
      router,
      stores: {
        admin: {
          overlayOpts: { id: 'group-classification' },
          sites: [],
          locales: [],
          classificationLevels: [
            { id: 'level-public', name: 'Public', sortOrder: 0 },
            { id: 'level-internal', name: 'Internal', sortOrder: 1 }
          ]
        }
      }
    })

    await flushPromises()

    return wrapper
  }

  it('shows the classification picker, not the plain path input, for a CLASSIFICATION rule', async () => {
    const wrapper = await mountWithClassificationRule()

    expect(wrapper.find('[aria-label="admin.groups.ruleClassifications"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="admin.groups.rulePath"]').exists()).toBe(false)
  })
})

/**
 * The mode radio defaults to `'replace'`, whose `onOk` branch clears every rule on the group, so
 * the prompt needs `cancel: true` or the only button offered is the destructive one.
 */
describe('GroupEditOverlay import rules confirmation', () => {
  async function mountRulesSectionWithOneRule() {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'group-import',
          name: 'Test Group',
          userCount: 0,
          permissions: [],
          rules: [
            {
              id: 'rule-1',
              name: 'Existing Rule',
              mode: 'ALLOW',
              roles: ['read:pages'],
              sites: [],
              match: 'START',
              path: '',
              locales: []
            }
          ]
        })
    })

    const router = await createTestRouter(['/:section'], '/rules')

    const { wrapper } = mountWithApp(GroupEditOverlay, {
      router,
      stores: {
        admin: {
          overlayOpts: { id: 'group-import' },
          sites: [],
          locales: [],
          classificationLevels: []
        },
        user: { permissions: ['manage:groups'] }
      }
    })

    await flushPromises()

    return wrapper
  }

  it('opens the import-mode prompt with cancel:true, and leaves rules untouched when canceled', async () => {
    const wrapper = await mountRulesSectionWithOneRule()

    fileOpen.mockResolvedValueOnce({
      text: () =>
        Promise.resolve(
          JSON.stringify([
            {
              name: 'Imported Rule',
              mode: 'DENY',
              match: 'START',
              roles: ['write:pages'],
              path: '',
              locales: [],
              sites: []
            }
          ])
        )
    })

    // -> The button is icon-only, so it is located by the `data-icon` `WIcon.vue` stamps onto the
    //    rendered SVG rather than by text.
    const importButton = wrapper
      .findAll('button')
      .find((b) => b.find('[data-icon="tabler:file-import"]').exists())
    expect(importButton).toBeTruthy()
    await importButton.trigger('click')
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].component).toBe(WConfirmDialog)
    expect(openDialogs[0].props.cancel).toBe(true)
    const dialogId = openDialogs[0].id

    // -> `WDialogHost` calls `closeDialog(id, false)` for any close that is not the `ok` event, so
    //    this is the Cancel button and `onOk`'s rule-clearing branch must never run.
    closeDialog(dialogId, false)
    await flushPromises()

    expect(wrapper.findAll('.admin-groups-rule')).toHaveLength(1)
    expect(wrapper.find('.admin-groups-rule-name input').element.value).toBe('Existing Rule')
  })
})
