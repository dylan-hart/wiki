import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ApiKeyRevokeDialog from './ApiKeyRevokeDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #788: `ApiKeyRevokeDialog` is reused by both `AdminApi.vue` (an admin revoking any key)
 * and `ProfileApi.vue` (a user revoking their own personal token) via two new props -- `endpoint`
 * (which REST resource to POST the revoke to) and `labelPrefix` (which i18n namespace to read its
 * strings from). Defaults reproduce the dialog's original, pre-#788 behavior exactly, so `AdminApi.vue`
 * needed no change to keep working.
 */
function mountDialog(props) {
  const i18n = createTestI18n({
    admin: { api: { revoke: 'Revoke', revokeConfirm: 'Revoke API Key?' } },
    profile: { api: { revoke: 'Revoke Token', revokeConfirm: 'Revoke Personal Access Token?' } }
  })
  return mount(ApiKeyRevokeDialog, {
    props: { apiKey: { id: 'key-1', name: 'My Key' }, ...props },
    global: { plugins: [i18n] }
  })
}

describe('ApiKeyRevokeDialog endpoint/labelPrefix', () => {
  it('defaults to the admin endpoint and label namespace, unchanged from before these props existed', async () => {
    globalThis.API_CLIENT.post.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const wrapper = mountDialog()
    expect(wrapper.vm.endpoint).toBe('api-keys')
    expect(wrapper.vm.labelPrefix).toBe('admin.api')
    expect(wrapper.vm.t(`${wrapper.vm.labelPrefix}.revokeConfirm`)).toBe('Revoke API Key?')

    await wrapper.vm.confirm()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith('api-keys/key-1/revoke')
  })

  it('posts to the given endpoint and reads its labels from the given prefix, for a personal token', async () => {
    globalThis.API_CLIENT.post.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const wrapper = mountDialog({
      endpoint: 'users/profile/api-keys',
      labelPrefix: 'profile.api'
    })
    expect(wrapper.vm.t(`${wrapper.vm.labelPrefix}.revokeConfirm`)).toBe(
      'Revoke Personal Access Token?'
    )

    await wrapper.vm.confirm()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith('users/profile/api-keys/key-1/revoke')
  })
})
