import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import UserDeleteDialog from './UserDeleteDialog.vue'
import UserSearchDialog from './UserSearchDialog.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #986: `UserDeleteDialog.vue` gained a "Reassign Content To..." picker, so an admin who
 * hits the ownership conflict never has to leave the delete flow to clear it. `chooseTargetUser()`
 * opens the real `UserSearchDialog` (in its new `singleSelect` mode) via the `dialog()` composable --
 * confirmed here the same way `GroupEditOverlay.test.js` confirms its own nested `UserSearchDialog`
 * use, by asserting on `openDialogs` and firing `closeDialog()` rather than mounting the nested
 * dialog's own tree.
 */

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
  openDialogs.splice(0)
})

function httpError(message) {
  return Object.assign(new Error('Request failed with status code 409'), {
    name: 'HTTPError',
    data: { message }
  })
}

function mountDialog(user = { id: 'user-1', name: 'Departing User' }) {
  setActivePinia(createPinia())

  const i18n = createTestI18n({
    admin: {
      users: {
        deleteSuccess: '{username} has been deleted.',
        deleteReassignChoose: 'Reassign Content To...'
      }
    },
    error: {
      ERR_REASSIGN_SAME_USER: 'Content cannot be reassigned to the same user.'
    }
  })

  currentWrapper = mount(UserDeleteDialog, {
    props: { user },
    global: { plugins: [i18n] }
  })
  return currentWrapper
}

async function clickDelete() {
  await flushPromises()
  const buttons = document.body.querySelectorAll('.card-actions button')
  buttons[buttons.length - 1].dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()
}

function clickChooseTargetUser() {
  const button = Array.from(document.body.querySelectorAll('button')).find((b) =>
    b.textContent.includes('Reassign Content To')
  )
  button.dispatchEvent(new Event('click', { bubbles: true }))
}

describe('UserDeleteDialog confirm()', () => {
  it('deletes directly, with no reassignment call, when no target user was picked', async () => {
    API_CLIENT.delete.mockReturnValueOnce({ ok: true })

    const wrapper = mountDialog()
    await clickDelete()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(API_CLIENT.delete).toHaveBeenCalledWith('users/user-1')
    expect(wrapper.emitted('ok')).toBeTruthy()
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })

  it('chooseTargetUser opens UserSearchDialog in singleSelect mode, excluding the departing user', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    clickChooseTargetUser()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].component).toBe(UserSearchDialog)
    expect(openDialogs[0].props.singleSelect).toBe(true)
    expect(openDialogs[0].props.excludeUserIds).toEqual(['user-1'])
    wrapper.unmount()
    currentWrapper = null
  })

  it('reassigns to the picked target before deleting, in that order', async () => {
    API_CLIENT.post.mockReturnValueOnce({ ok: true })
    API_CLIENT.delete.mockReturnValueOnce({ ok: true })

    const wrapper = mountDialog()
    await flushPromises()
    clickChooseTargetUser()
    closeDialog(openDialogs[0].id, true, [{ id: 'user-2', name: 'Target User' }])
    await flushPromises()

    await clickDelete()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.post.mock.calls[0][0]).toBe('users/user-1/reassignContent')
    expect(API_CLIENT.post.mock.calls[0][1]).toEqual({ json: { targetUserId: 'user-2' } })
    expect(API_CLIENT.delete).toHaveBeenCalledWith('users/user-1')
    expect(wrapper.emitted('ok')).toBeTruthy()
  })

  it('stops before deleting when reassignment itself fails', async () => {
    const err = new Error('Bad Request')
    err.data = { message: 'ERR_REASSIGN_SAME_USER' }
    API_CLIENT.post.mockImplementationOnce(() => {
      throw err
    })

    const wrapper = mountDialog()
    await flushPromises()
    clickChooseTargetUser()
    closeDialog(openDialogs[0].id, true, [{ id: 'user-2', name: 'Target User' }])
    await flushPromises()

    await clickDelete()

    expect(API_CLIENT.delete).not.toHaveBeenCalled()
    expect(wrapper.emitted('ok')).toBeUndefined()
    // -> The raw ERR_ code is translated via localizeError(), not shown to the admin verbatim
    expect(notifyQueue.at(-1)?.message).toBe('Content cannot be reassigned to the same user.')
    expect(notifyQueue.at(-1)?.type).toBe('negative')
  })

  it('surfaces the server-provided ownership-conflict message from the delete route unchanged', async () => {
    API_CLIENT.delete.mockImplementationOnce(() => {
      throw httpError('Cannot delete a user who still owns pages or assets. Reassign them first.')
    })

    const wrapper = mountDialog()
    await clickDelete()

    expect(notifyQueue.at(-1)?.message).toBe(
      'Cannot delete a user who still owns pages or assets. Reassign them first.'
    )
    expect(wrapper.emitted('ok')).toBeUndefined()
  })
})
