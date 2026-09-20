import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileAvatar from './ProfileAvatar.vue'
import { mountWithApp } from '../../test/mount.js'
import { pendingProfileSaves } from '@/composables/profileSaving'

/**
 * Shape only: whether the preview really sits under both halves of the row is geometry, which
 * happy-dom has no layout engine to answer and a real-browser suite measures instead.
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

function mountPage({ canEdit = true, hasAvatar = false, avatarProviderUrl = null } = {}) {
  return mountWithApp(ProfileAvatar, {
    messages: MESSAGES,
    stores: {
      site: (store) => {
        store.features = { profile: canEdit }
      },
      user: { hasAvatar, avatarProviderUrl, name: 'Ada Lovelace' }
    }
  }).wrapper
}

describe('ProfileAvatar', () => {
  beforeEach(() => {
    pendingProfileSaves.value = 0
  })

  /**
   * `uploadImage()` builds its own detached `<input type="file">`, and a real DOM input's `files`
   * cannot be assigned in a test, so `document.createElement` hands back a plain object instead --
   * nothing here reads more of the input than `.onchange`/`.click()`.
   */
  describe('pendingProfileSaves (OpenProject #3282)', () => {
    let realCreateElement
    let fakeInput

    beforeEach(() => {
      realCreateElement = document.createElement.bind(document)
      fakeInput = { click: vi.fn() }
      vi.spyOn(document, 'createElement').mockImplementation((tag) =>
        tag === 'input' ? fakeInput : realCreateElement(tag)
      )
    })

    afterEach(() => {
      document.createElement.mockRestore()
    })

    it('counts uploadImage() while the PUT is in flight', async () => {
      const wrapper = mountPage()
      await flushPromises()
      let resolvePut
      globalThis.API_CLIENT.put.mockReturnValue({
        json: () =>
          new Promise((resolve) => {
            resolvePut = resolve
          })
      })

      wrapper.vm.uploadImage()
      await flushPromises()
      const file = new File(['x'], 'avatar.png', { type: 'image/png' })
      const changePromise = fakeInput.onchange({ target: { files: [file] } })
      await flushPromises()
      expect(pendingProfileSaves.value).toBe(1)

      resolvePut({})
      await changePromise
      expect(pendingProfileSaves.value).toBe(0)
    })

    it('counts clearImage() while the DELETE is in flight', async () => {
      const wrapper = mountPage({ hasAvatar: true })
      await flushPromises()
      let resolveDelete
      globalThis.API_CLIENT.delete.mockReturnValue({
        json: () =>
          new Promise((resolve) => {
            resolveDelete = resolve
          })
      })

      const clearPromise = wrapper.vm.clearImage()
      await flushPromises()
      expect(pendingProfileSaves.value).toBe(1)

      resolveDelete({})
      await clearPromise
      expect(pendingProfileSaves.value).toBe(0)
    })
  })

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

  it('falls back to the provider avatar when there is no manual upload', async () => {
    const wrapper = mountPage({
      hasAvatar: false,
      avatarProviderUrl: 'https://provider.example/photo.jpg'
    })
    await flushPromises()

    const preview = wrapper.find('.w-settings-row__preview')
    expect(preview.find('img').attributes('src')).toBe('https://provider.example/photo.jpg')
  })

  it('prefers the manual upload over a provider avatar when both are present', async () => {
    const wrapper = mountPage({
      hasAvatar: true,
      avatarProviderUrl: 'https://provider.example/photo.jpg'
    })
    await flushPromises()

    const preview = wrapper.find('.w-settings-row__preview')
    expect(preview.find('img').attributes('src')).toContain('/_user/current/avatar?')
  })

  it('falls back to the generic glyph when neither avatar exists', async () => {
    const wrapper = mountPage({ hasAvatar: false, avatarProviderUrl: null })
    await flushPromises()

    const preview = wrapper.find('.w-settings-row__preview')
    expect(preview.find('img').exists()).toBe(false)
    expect(preview.find('.w-icon').exists()).toBe(true)
  })

  it('says why there is nothing to press when the site has profile editing turned off', async () => {
    const wrapper = mountPage({ canEdit: false })
    await flushPromises()

    const control = wrapper.find('.w-settings-row__control')
    expect(control.findAll('button')).toHaveLength(0)
    expect(control.text()).toContain('cannot be changed')
    // -> Being unable to change an avatar is not being unable to see it.
    expect(wrapper.find('.w-settings-row__preview').exists()).toBe(true)
  })
})
