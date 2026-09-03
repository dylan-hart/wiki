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
 * Task #684: `GroupEditOverlay.vue`'s rule editor is extended to offer the eight `site:*` site-admin
 * permissions (see `backend/helpers/siteRules.ts`'s `SITE_PERMISSIONS`) as selectable `roles` entries
 * in the SAME picker page permissions already use, rather than a second UI -- per the decision record
 * at `docs/decisions/delegated-per-site-administration.md`.
 *
 * Mounted at the `rules` section for a non-guest group whose one rule already holds all eight
 * `site:*` permissions in `roles` -- exactly the shape a saved group would come back as. The
 * `#selected-item` template renders each held role as a chip labelled with its catalog `title`, so a
 * permission string missing from (or misspelled in) the catalog array this test guards would either
 * render no chip for it or a blank one, not the expected title text.
 */
const SITE_PERMISSION_TITLES = {
  'site:general': 'Site: General Settings',
  'site:theme': 'Site: Theme',
  'site:navigation': 'Site: Navigation',
  'site:blocks': 'Site: Blocks',
  'site:approvals': 'Site: Approval Rules',
  'site:login': 'Site: Login & Authentication',
  'site:locale': 'Site: Locale',
  'site:editors': 'Site: Editors'
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

  // -> Task #1602: the catalog's `title:`/`hint:` now resolve through `t()` from
  //    `admin.groups.permissions.<permission>.title`, not a hardcoded literal in the module-scope
  //    array -- so this bundle must actually carry those keys for the rendered chip to show the
  //    expected text instead of the raw untranslated key.

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

/**
 * Task 451: verify `assignUser()`'s partial-failure UX (~L1217-1254). It multi-selects users via
 * `UserSearchDialog` and loops one `POST /_api/groups/:id/users/:userId` per user, so a failure
 * partway through a batch must still: (1) leave the successful ones assigned, (2) surface one
 * `admin.groups.assignUserFailed` notification per failure carrying the failing user's name and the
 * API's own error message as the caption, (3) surface one summary `assignUserSuccess` notification
 * counting only the successes, and (4) end with `refreshUsers()` reflecting the true post-batch
 * membership rather than an optimistic client-side merge.
 *
 * The real `UserSearchDialog` is never mounted -- exercising it end-to-end would only be testing
 * that component's own search UI, not the loop under test. Instead this drives the exact mechanism
 * a real dialog uses to report its result: `WDialogHost` (frontend/src/components/shared/
 * WDialogHost.vue) listens for the dialog's `@ok` event and calls `closeDialog(id, true, payload)`,
 * so calling `closeDialog` directly with a fake `payload` array is a faithful simulation of a user
 * multi-selecting a batch and confirming, not a reimplementation of the dialog.
 */
async function mountWithGroup() {
  const router = await createTestRouter(['/:id?/:section?'], '/group-1/users')

  // -> Real strings (backend/locales/en.json), not the raw i18n keys the empty bundle used
  //    elsewhere in this suite falls back to: this test asserts on the actual interpolated text
  //    (the failing user's name, the pluralized success count), so the keys need real values.

  // -> onMounted() calls checkRoute() before fetchGroup(); on the `users` section, checkRoute()
  //    calls refreshUsers() synchronously first, so its GET is issued (and must be mocked) ahead of
  //    fetchGroup()'s, even though fetchGroup() is declared second in the component's own source.
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

/**
 * OpenProject #1925: the rules/permissions/users sections each carried a "?" help button linking to
 * `siteStore.docsBase + '/admin/permissions#...'` or `'/admin/groups#users'` -- upstream docs pages
 * that describe upstream's classic RBAC model, not this fork's three permission kinds (global,
 * page-rule, and `site:*` delegation -- see `backend/helpers/siteRules.ts`) or its
 * `manage:classification` guardrail. No accurate fork-specific target exists yet, so the buttons are
 * removed rather than left teaching the wrong model or pointing at `siteStore.docsBase` at all.
 */
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

/**
 * OpenProject #1602: `permissions`' (the global-permission catalog) `hint:` used to be a raw English
 * literal baked into the module-scope array. It now resolves through `t()` from
 * `admin.groups.permissions.<permission>.hint` in the `permissions` computed. Supplying a dictionary
 * value here that does not match the original English literal, and asserting the rendered row shows
 * exactly that value, is what proves the hint is actually read from the i18n dictionary at render
 * time rather than still being a literal the catalog carries -- a hardcoded literal could never
 * produce this text.
 */
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

/**
 * OpenProject #1942: `manage:classification` (the 16th and last entry of `PAGE_PERMISSIONS`,
 * `backend/helpers/permissions.ts`) was enforced by the API but absent from the group editor's
 * `rules` catalog, so it was grantable only by hand-crafting group-rule JSON against
 * `PUT /groups/:id` -- no non-`manage:system` user could ever lower a page's classification through
 * the UI. Mirrors the `site:` permission vocabulary test above: a rule already holding the
 * permission in its `roles` must render a chip labelled with the catalog's title.
 */
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

    // -> Task #1602's i18n conversion of the `rules` catalog means the rendered chip title now comes
    //    from this mounted dictionary, not a component literal -- see the `site:` permission test
    //    above for the same requirement.

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

/**
 * OpenProject #2182: START/END/EXACT compare `path` directly against a page path, which is always
 * stored lowercased -- typing an uppercase character there would save a rule that can never match
 * (silently, for a DENY). The rule path input folds to lowercase as the administrator types, for
 * these match kinds, rather than only rejecting the mismatch on save.
 */
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

    // -> `assignUser` isn't a key defined in this test's i18n bundle, so `t()` falls back to the raw
    //    key -- same technique UserEditOverlay.test.js uses for its Save button.
    const assignButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('admin.groups.assignUser') && !b.text().includes('Title'))
    expect(assignButton).toBeTruthy()
    await assignButton.trigger('click')

    // -> assignUser() called dialog({ component: UserSearchDialog, ... }); confirm it actually
    //    opened the real search dialog rather than some other component.
    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].component).toBe(UserSearchDialog)
    const dialogId = openDialogs[0].id

    const userTwo = { id: 'user-2', name: 'User Two' }
    const userThree = { id: 'user-3', name: 'User Three' }
    const userFour = { id: 'user-4', name: 'User Four' }

    // -> user-2 and user-4 succeed; user-3 fails as the API's own 409 "already a member" conflict
    //    (guests/system-user or already-assigned both surface identically to the client: a rejected
    //    .json() call carrying `{ data: { message } }`, which is what apiErrorMessage() reads).
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.post.mockReturnValueOnce({
      json: () => {
        const err = new Error('Conflict')
        err.data = { message: 'User is already assigned to this group.' }
        return Promise.reject(err)
      }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    // -> The post-batch refreshUsers() call: server-truth membership after the batch, not an
    //    optimistic splice of the payload onto state.users.
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
    // -> Simulates UserSearchDialog firing `ok` with its multi-selection, exactly as WDialogHost
    //    would relay it.
    closeDialog(dialogId, true, [userTwo, userThree, userFour])
    await flushPromises()
    await flushPromises()
    await flushPromises()

    // -> One POST per selected user, sequentially -- confirms the loop, not a bulk endpoint
    expect(API_CLIENT.post).toHaveBeenCalledTimes(3)
    expect(API_CLIENT.post).toHaveBeenNthCalledWith(1, 'groups/group-1/users/user-2')
    expect(API_CLIENT.post).toHaveBeenNthCalledWith(2, 'groups/group-1/users/user-3')
    expect(API_CLIENT.post).toHaveBeenNthCalledWith(3, 'groups/group-1/users/user-4')

    // -> Exactly one failure notification, naming the failed user and carrying the API's own
    //    conflict message as the caption
    const failureToasts = notifyQueue.filter((n) => n.type === 'negative')
    expect(failureToasts).toHaveLength(1)
    expect(failureToasts[0].message).toBe('Failed to assign User Three to this group.')
    expect(failureToasts[0].caption).toBe('User is already assigned to this group.')

    // -> Exactly one success summary, counting only the 2 that actually succeeded (not 3)
    const successToasts = notifyQueue.filter((n) => n.type === 'positive')
    expect(successToasts).toHaveLength(1)
    expect(successToasts[0].message).toBe('2 users were assigned to the group successfully.')

    // -> refreshUsers() ran after the batch and its server response -- not a client-side merge of
    //    the dialog's payload -- is what ended up on screen
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'groups/group-1/users',
      expect.objectContaining({ searchParams: expect.any(Object) })
    )
    const names = wrapper.findAll('td').map((td) => td.text())
    expect(names.join(' ')).toContain('User Two')
    expect(names.join(' ')).toContain('User Four')
    // -> User Three never got assigned -- it must not appear as if it had been
    expect(names.join(' ')).not.toContain('User Three')
  })
})

/**
 * OpenProject #2039: `unassignUser()` used to pass `cancel: true, persistent: true` but never
 * `color`/`okLabel`, leaving a primary-blue OK on an irreversible unassign. Now matches the reference
 * treatment (`AdminIcons.vue`'s `confirmDeleteSet()`).
 */
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

/**
 * OpenProject #1079: the rule editor's match dropdown gains a `CLASSIFICATION` option, which reads
 * `rule.classifications` (a level-id multi-select) rather than `rule.path` (the plain text input
 * every other match kind shares) -- `PagePropertiesDialog.vue`'s own picker is covered separately, at
 * the model layer this reaches (`backend/helpers/pageRules.test.ts`); this is about which control the
 * rule editor shows for which match kind.
 */
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
 * OpenProject #2034: `importRules()`'s mode-choice prompt was opened with `persistent: true` and no
 * `cancel`, so `WConfirmDialog` rendered exactly one button. The `model` radio defaults to
 * `'replace'`, whose `onOk` branch runs `state.group.rules = []` -- pressing the only available
 * button to back out of the modal discarded every rule on the group. Fixed by adding `cancel: true`
 * to that one `confirm()` call.
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

    // -> `importRules` isn't a key defined in this test's i18n bundle, so the tooltip text falls back
    //    to the raw key -- but the button carries no visible text of its own (icon-only), so it's
    //    located by the `data-icon` WIcon.vue stamps onto the rendered SVG instead.
    const importButton = wrapper
      .findAll('button')
      .find((b) => b.find('[data-icon="la:file-import"]').exists())
    expect(importButton).toBeTruthy()
    await importButton.trigger('click')
    await flushPromises()

    // -> importRules() opened the mode-choice prompt via WConfirmDialog, and -- the actual fix --
    //    passed `cancel: true` so the dialog has a non-destructive exit alongside its OK button.
    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].component).toBe(WConfirmDialog)
    expect(openDialogs[0].props.cancel).toBe(true)
    const dialogId = openDialogs[0].id

    // -> Simulates the user backing out via the new Cancel button: WDialogHost calls
    //    `closeDialog(id, false)` for any close that isn't the `ok` event, so `onOk`'s
    //    `state.group.rules = []` branch must never run.
    closeDialog(dialogId, false)
    await flushPromises()

    expect(wrapper.findAll('.admin-groups-rule')).toHaveLength(1)
    expect(wrapper.find('.admin-groups-rule-name input').element.value).toBe('Existing Rule')
  })
})
