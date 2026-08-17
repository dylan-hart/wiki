import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import UserEditOverlay from './UserEditOverlay.vue'
import BlueprintIcon from './BlueprintIcon.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'

/**
 * Regression test for `unassignGroup(id)`: it filtered `state.user.groups` with `gr.id === id`,
 * which KEEPS only the group being removed and drops every other one -- the exact opposite of the
 * button's action ("Unassign Group X" would leave the user in every group EXCEPT X once saved).
 * Correct behaviour is `gr.id !== id`, dropping only the targeted group.
 */
async function mountWithUser(groups) {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  adminStore.overlayOpts = { id: 'user-1' }

  const userStore = useUserStore()
  userStore.permissions = ['manage:users']

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:id?/:section?', component: { template: '<div />' } }]
  })
  router.push('/user-1/groups')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

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

  const wrapper = mount(UserEditOverlay, {
    global: {
      plugins: [router, i18n],
      components: { BlueprintIcon }
    }
  })

  await flushPromises()

  return wrapper
}

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
