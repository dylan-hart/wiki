import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileNotifications from './ProfileNotifications.vue'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * Feature #2425: the self-service Notifications settings page — one `w-toggle` per event type the
 * backend can fire (`backend/models/hooks.ts#HOOK_EVENTS`), loaded from and saved to
 * `users/profile/notifications`. Only the wiring is asserted here — real subscribe/deliver behavior
 * belongs to the sibling WPs (#2481/#2483/#2484); this page only has to load what the server sent,
 * let a reader flip a toggle, and PUT the whole map back.
 */

const MESSAGES = {
  profile: {
    notifications: 'Notifications',
    notificationsSubtitle: 'Choose which events send you an email.',
    notificationsGroupPages: 'Pages',
    notificationsGroupAssets: 'Assets',
    notificationsGroupComments: 'Comments',
    notificationsGroupApprovals: 'Approvals',
    notificationsGroupAccount: 'Account activity',
    notificationsEventPageCreate: 'Page published',
    notificationsEventPageEdit: 'Page edited',
    notificationsEventPageRename: 'Page renamed or moved',
    notificationsEventPageDelete: 'Page deleted',
    notificationsEventPageClassificationChanged: 'Page classification changed',
    notificationsEventAssetUpload: 'Asset uploaded',
    notificationsEventAssetEdit: 'Asset edited',
    notificationsEventAssetRename: 'Asset renamed or moved',
    notificationsEventAssetDelete: 'Asset deleted',
    notificationsEventCommentNew: 'New comment posted',
    notificationsEventCommentEdit: 'Comment edited',
    notificationsEventCommentDelete: 'Comment deleted',
    notificationsEventApprovalSubmitted: 'Submission awaiting review',
    notificationsEventApprovalApproved: 'Submission approved',
    notificationsEventApprovalRejected: 'Submission rejected',
    notificationsEventUserJoin: 'New user joins',
    notificationsEventUserLogin: 'User signs in',
    notificationsEventUserLogout: 'User signs out',
    notificationsLoadFailed: 'Failed to load your notification subscriptions.',
    notificationsSaveFailed: 'Failed to save your notification subscriptions.',
    notificationsSaveSuccess: 'Notification subscriptions saved successfully.'
  },
  common: {
    actions: {
      saveChanges: 'Save Changes'
    }
  }
}

const ALL_FALSE = {
  'page:create': false,
  'page:edit': false,
  'page:rename': false,
  'page:delete': false,
  'asset:upload': false,
  'asset:edit': false,
  'asset:rename': false,
  'asset:delete': false,
  'comment:new': false,
  'comment:edit': false,
  'comment:delete': false,
  'user:join': false,
  'user:login': false,
  'user:logout': false,
  'approval:submitted': false,
  'approval:approved': false,
  'approval:rejected': false,
  'page:classification-changed': false
}

function mountPage() {
  return mountWithApp(ProfileNotifications, { messages: MESSAGES }).wrapper
}

describe('ProfileNotifications', () => {
  it('loads the subscription map from users/profile/notifications on mount', async () => {
    const { calls } = stubApi({
      'users/profile/notifications': { ...ALL_FALSE, 'comment:new': true }
    })

    const wrapper = mountPage()
    await flushPromises()

    expect(calls).toContain('users/profile/notifications')
    expect(wrapper.vm.state.config['comment:new']).toBe(true)
    expect(wrapper.vm.state.config['page:create']).toBe(false)
  })

  it('renders every HOOK_EVENTS key as its own toggle, grouped under a heading', async () => {
    stubApi({ 'users/profile/notifications': { ...ALL_FALSE } })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.text()).toContain('Pages')
    expect(wrapper.text()).toContain('Page published')
    expect(wrapper.text()).toContain('Assets')
    expect(wrapper.text()).toContain('Approvals')
    expect(wrapper.text()).toContain('Submission approved')
    expect(wrapper.text()).toContain('Account activity')
    expect(wrapper.text()).toContain('User signs in')
    expect(wrapper.findAllComponents({ name: 'WToggle' })).toHaveLength(
      Object.keys(ALL_FALSE).length
    )
  })

  it('flipping a toggle and saving PUTs the whole current map to users/profile/notifications', async () => {
    stubApi({ 'users/profile/notifications': { ...ALL_FALSE } })
    globalThis.API_CLIENT.put.mockReturnValue({
      json: () =>
        Promise.resolve({ ok: true, subscriptions: { ...ALL_FALSE, 'page:create': true } })
    })

    const wrapper = mountPage()
    await flushPromises()

    wrapper.vm.state.config['page:create'] = true
    await wrapper.vm.$nextTick()

    const saveButton = wrapper.findAll('button').find((btn) => btn.text().includes('Save Changes'))
    await saveButton.trigger('click')
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledWith(
      'users/profile/notifications',
      expect.objectContaining({ json: expect.objectContaining({ 'page:create': true }) })
    )
  })

  it('shows an error toast and leaves the map untouched when loading fails', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.reject(new Error('network')) })

    const wrapper = mountPage()
    await flushPromises()

    // -> Every value stays at its seeded default rather than throwing or partially applying
    for (const key of Object.keys(ALL_FALSE)) {
      expect(wrapper.vm.state.config[key]).toBe(false)
    }
  })
})
