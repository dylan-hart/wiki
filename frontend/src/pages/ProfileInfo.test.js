import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileInfo from './ProfileInfo.vue'
import { useSiteStore } from '@/stores/site'

import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2074: `ProfileInfo.vue`'s "Save Changes" button used to draw `la:check` while every
 * `Admin*.vue` settings page draws `mdi:check` for the identical "commit these settings" action
 * (`icon="mdi:check"` + `t('common.actions.apply')`) -- settled on `mdi:check` for that action, so
 * this page's Save button must not regress back to the other glyph.
 */
function mountPage() {
  // -> The Save button only renders once editing is allowed (`canEdit`, gated on this feature flag).

  return mountWithApp(ProfileInfo, {
    messages: {
      common: {
        actions: {
          saveChanges: 'Save Changes'
        }
      }
    },
    stores: {
      site: (store) => {
        store.features.profile = true
      }
    }
  }).wrapper
}

describe('ProfileInfo "Save Changes" icon (OpenProject #2074)', () => {
  it('uses the settled mdi:check save/commit glyph, not la:check', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('[data-icon="mdi:check"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="la:check"]').exists()).toBe(false)
  })
})
