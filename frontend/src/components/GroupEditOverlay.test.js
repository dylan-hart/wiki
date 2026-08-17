import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import GroupEditOverlay from './GroupEditOverlay.vue'
import UserSearchDialog from './UserSearchDialog.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'

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
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  adminStore.overlayOpts = { id: 'group-1' }

  const userStore = useUserStore()
  userStore.permissions = ['manage:groups']

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:id?/:section?', component: { template: '<div />' } }]
  })
  router.push('/group-1/users')
  await router.isReady()

  // -> Real strings (backend/locales/en.json), not the raw i18n keys the empty bundle used
  //    elsewhere in this suite falls back to: this test asserts on the actual interpolated text
  //    (the failing user's name, the pluralized success count), so the keys need real values.
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        admin: {
          groups: {
            assignUserFailed: 'Failed to assign {userName} to this group.',
            assignUserSuccess:
              'User was assigned to the group successfully. | {count} users were assigned to the group successfully.'
          }
        }
      }
    }
  })

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

  const wrapper = mount(GroupEditOverlay, {
    global: {
      plugins: [router, i18n]
    }
  })

  await flushPromises()

  return wrapper
}

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
