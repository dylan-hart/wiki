import { describe, expect, it } from 'vitest'

import AdminFlags from './AdminFlags.vue'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

describe('AdminFlags', () => {
  it('offers only the real flag switches, with no custom-configuration card', async () => {
    stubApi({
      'system/flags': { experimental: false, authDebug: false, sqlLog: false }
    })

    const { wrapper } = mountWithApp(AdminFlags, {
      messages: {
        admin: {
          flags: {
            advanced: { label: 'Custom Configuration' },
            serverLogNotice: 'notice'
          }
        }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.w-settings-card')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('Custom Configuration')
    expect(wrapper.find('button[disabled]').exists()).toBe(false)
  })
})
