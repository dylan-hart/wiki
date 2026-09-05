import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminLogin from './AdminLogin.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * Same regression as `AdminGeneral.test.js`: the login background uploader's `<blueprint-icon
 * indicator ...>` was another bare-attribute instance of the same bug, fixed the same way — only a
 * truthy `indicator` once `system/extensions` reports the `sharp` entry as `!isInstalled`.
 */
async function mountPage(extensionsResponse) {
  stubApi({ 'system/extensions': extensionsResponse })

  const router = await createTestRouter(['/'])

  const { wrapper } = mountWithApp(AdminLogin, { router })
  await flushPromises()

  return wrapper
}

describe('AdminLogin — Sharp availability indicator', () => {
  it('hides the indicator on the background uploader when Sharp is installed', async () => {
    const wrapper = await mountPage([
      { key: 'sharp', title: 'Sharp', isInstalled: true, isInstallable: true, isCompatible: true }
    ])

    const bgIcon = wrapper
      .findAllComponents(BlueprintIcon)
      .find((c) => c.props('icon') === 'tabler:photo')

    expect(bgIcon.props('indicator')).toBe(null)
    expect(wrapper.find('.w-badge').exists()).toBe(false)
  })

  it('shows the indicator on the background uploader when Sharp is not installed', async () => {
    const wrapper = await mountPage([
      { key: 'sharp', title: 'Sharp', isInstalled: false, isInstallable: true, isCompatible: true }
    ])

    const bgIcon = wrapper
      .findAllComponents(BlueprintIcon)
      .find((c) => c.props('icon') === 'tabler:photo')

    expect(bgIcon.props('indicator')).toBe('')
    expect(wrapper.find('.w-badge').exists()).toBe(true)
  })
})
