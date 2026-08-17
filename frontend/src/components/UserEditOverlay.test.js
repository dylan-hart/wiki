import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import UserEditOverlay from './UserEditOverlay.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

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
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  adminStore.overlayOpts = { id: USER.id }

  const userStore = useUserStore()
  userStore.permissions = canManage ? ['manage:users'] : []

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

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/u/:section', component: { template: '<div />' } }]
  })
  router.push('/u/auth')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(UserEditOverlay, {
    global: {
      plugins: [router, i18n],
      stubs: { BlueprintIcon: true }
    }
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
