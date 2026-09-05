import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileInfo from './ProfileInfo.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2074: `ProfileInfo.vue`'s "Save Changes" button used to draw a different check from the
 * one every `Admin*.vue` settings page draws for the identical "commit these settings" action
 * (`icon="tabler:check"` + `t('common.actions.apply')`). That action is settled on `tabler:check`, so
 * this page's Save button must not drift to a ringed variant -- `tabler:circle-check` is the one
 * sitting closest to it in the set.
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
  it('uses the settled tabler:check save/commit glyph, not tabler:circle-check', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('[data-icon="tabler:check"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="tabler:circle-check"]').exists()).toBe(false)
  })
})
