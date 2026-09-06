import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileAvatar from './ProfileAvatar.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2701 -- the avatar section on the settings pattern.
 *
 * What is worth pinning here is the SHAPE, since the page's behaviour (upload, clear) was not
 * touched: the image is the row's stacked `preview`, the same slot Admin General's logo row uses,
 * rather than a second stacked variant invented for this page; and the row still says why the
 * buttons are missing when the site has profile editing turned off, instead of silently rendering
 * an empty control. Geometry -- that the preview really does sit under both halves of the row -- is
 * measured in a real browser by `pages/profileSettingsRhythm.layout.test.js`; happy-dom has no
 * layout engine to answer it here.
 */

const MESSAGES = {
  common: { actions: { clear: 'Clear' } },
  profile: {
    avatar: 'Avatar',
    avatarUploadTitle: 'Upload your user profile picture.',
    avatarUploadHint: 'For best results, use a 180x180 image of type JPG or PNG.',
    avatarUploadDisabled: 'Your avatar is set by your organization and cannot be changed.',
    uploadNewAvatar: 'Upload New Image'
  }
}

function mountPage({ canEdit = true, hasAvatar = false } = {}) {
  return mountWithApp(ProfileAvatar, {
    messages: MESSAGES,
    stores: {
      site: (store) => {
        store.features = { profile: canEdit }
      },
      user: { hasAvatar, name: 'Ada Lovelace' }
    }
  }).wrapper
}

describe('ProfileAvatar', () => {
  it('draws one settings card whose single row carries the plate, the label and the hint', async () => {
    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.findAll('.w-settings-card')).toHaveLength(1)
    const rows = wrapper.findAll('.w-settings-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].find('.blueprint-icon').exists()).toBe(true)
    expect(rows[0].find('.w-settings-row__label').text()).toBe('Upload your user profile picture.')
    expect(rows[0].find('.w-settings-row__hint').text()).toContain('180x180')
  })

  it('puts the image in the row preview slot, not beside the control', async () => {
    const wrapper = mountPage({ hasAvatar: true })
    await flushPromises()

    const preview = wrapper.find('.w-settings-row__preview')
    expect(preview.exists()).toBe(true)
    expect(preview.find('.profile-avatar-circ').exists()).toBe(true)
    // -> The real avatar image, cache-busted, rather than the fallback glyph
    expect(preview.find('img').attributes('src')).toContain('/_user/current/avatar?')
    expect(wrapper.find('.w-settings-row__control').find('.profile-avatar-circ').exists()).toBe(
      false
    )
  })

  it('offers upload and clear at the trailing edge, with clear off until there is an avatar', async () => {
    const wrapper = mountPage({ hasAvatar: false })
    await flushPromises()

    const control = wrapper.find('.w-settings-row__control')
    const labels = control.findAll('button').map((btn) => btn.text())
    expect(labels.some((text) => text.includes('Upload New Image'))).toBe(true)

    const clear = control.findAll('button').find((btn) => btn.text().includes('Clear'))
    expect(clear.attributes('disabled')).toBeDefined()
  })

  it('says why there is nothing to press when the site has profile editing turned off', async () => {
    const wrapper = mountPage({ canEdit: false })
    await flushPromises()

    const control = wrapper.find('.w-settings-row__control')
    expect(control.findAll('button')).toHaveLength(0)
    expect(control.text()).toContain('cannot be changed')
    // -> The preview stays: the reader can still SEE their avatar, they just cannot change it
    expect(wrapper.find('.w-settings-row__preview').exists()).toBe(true)
  })
})
