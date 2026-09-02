import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive, toRef } from 'vue'

import { queue as notifyQueue } from '@/composables/notify'
import { useSiteImage } from './siteImage.js'

import { createTestI18n } from '../../test/i18n.js'

/*
  The transport helpers are the boundary this composable orchestrates -- a real `pickSiteImage()`
  would open a file picker no test can answer, so the four of them are mocked and the assertions are
  about the orchestration: the invalid-type guard, the `has` flag, the loading counter, the three
  toasts and the cache-busting timestamp.
*/
const siteImages = vi.hoisted(() => ({
  pickSiteImage: vi.fn(),
  isAcceptedSiteImage: vi.fn(),
  uploadSiteImage: vi.fn(),
  clearSiteImage: vi.fn()
}))

vi.mock('@/helpers/siteImages', () => siteImages)

const I18N_PREFIX = 'admin.general.logo'

/**
 * `useSiteImage` calls `useI18n()`, so it needs a real component instance -- this mounts a harness
 * whose only job is to run the composable and hand back what it returned.
 */
function mountComposable(kind, opts) {
  const state = reactive({ loading: 0, hasImage: false })
  let api = null

  const i18n = createTestI18n()
  const wrapper = mount(
    {
      setup() {
        api = useSiteImage(kind, {
          siteId: () => 'site-1',
          has: toRef(state, 'hasImage'),
          i18nPrefix: I18N_PREFIX,
          loading: toRef(state, 'loading'),
          ...opts
        })
        return () => null
      }
    },
    { global: { plugins: [i18n] } }
  )

  return { api, state, wrapper }
}

const FILE = { type: 'image/png' }

beforeEach(() => {
  notifyQueue.splice(0)
  siteImages.pickSiteImage.mockReset()
  siteImages.isAcceptedSiteImage.mockReset()
  siteImages.uploadSiteImage.mockReset()
  siteImages.clearSiteImage.mockReset()
})

describe('useSiteImage() upload', () => {
  it('uploads the picked file, flags the image as present and reports success', async () => {
    siteImages.pickSiteImage.mockResolvedValue(FILE)
    siteImages.isAcceptedSiteImage.mockReturnValue(true)
    siteImages.uploadSiteImage.mockResolvedValue(undefined)
    const { api, state } = mountComposable('logo')

    await api.upload()
    await flushPromises()

    expect(siteImages.uploadSiteImage).toHaveBeenCalledWith('site-1', 'logo', FILE)
    expect(state.hasImage).toBe(true)
    expect(state.loading).toBe(0)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: `${I18N_PREFIX}UploadSuccess`
    })
  })

  it('does nothing at all when the picker is dismissed', async () => {
    siteImages.pickSiteImage.mockResolvedValue(null)
    const { api, state } = mountComposable('logo')

    await api.upload()

    expect(siteImages.uploadSiteImage).not.toHaveBeenCalled()
    expect(state.hasImage).toBe(false)
    expect(notifyQueue).toHaveLength(0)
  })

  it('refuses a file the endpoint would not take, without uploading it', async () => {
    siteImages.pickSiteImage.mockResolvedValue({ type: 'application/pdf' })
    siteImages.isAcceptedSiteImage.mockReturnValue(false)
    const { api, state } = mountComposable('logo')

    await api.upload()

    expect(siteImages.uploadSiteImage).not.toHaveBeenCalled()
    expect(state.hasImage).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: `${I18N_PREFIX}UploadFailed`,
      caption: `${I18N_PREFIX}UploadInvalidType`
    })
  })

  it('uses an explicit invalidTypeKey when the caller shares one message across uploaders', async () => {
    siteImages.pickSiteImage.mockResolvedValue({ type: 'application/pdf' })
    siteImages.isAcceptedSiteImage.mockReturnValue(false)
    const { api } = mountComposable('logo', {
      invalidTypeKey: 'admin.general.imageUploadInvalidType'
    })

    await api.upload()

    expect(notifyQueue.at(-1)).toMatchObject({
      caption: 'admin.general.imageUploadInvalidType'
    })
  })

  it('reports a failed upload and leaves the image flag alone', async () => {
    siteImages.pickSiteImage.mockResolvedValue(FILE)
    siteImages.isAcceptedSiteImage.mockReturnValue(true)
    siteImages.uploadSiteImage.mockRejectedValue(new Error('Network error'))
    const { api, state } = mountComposable('logo')

    await api.upload()
    await flushPromises()

    expect(state.hasImage).toBe(false)
    expect(state.loading).toBe(0)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: `${I18N_PREFIX}UploadFailed`,
      caption: 'Network error'
    })
  })

  it('bumps the cache-busting timestamp on a successful upload', async () => {
    siteImages.pickSiteImage.mockResolvedValue(FILE)
    siteImages.isAcceptedSiteImage.mockReturnValue(true)
    siteImages.uploadSiteImage.mockResolvedValue(undefined)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const { api } = mountComposable('logo')
      const before = api.timestamp.value

      vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
      await api.upload()
      await flushPromises()

      expect(api.timestamp.value).not.toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useSiteImage() clear', () => {
  it('clears the image, lowers the flag and reports success', async () => {
    siteImages.clearSiteImage.mockResolvedValue(undefined)
    const { api, state } = mountComposable('favicon')
    state.hasImage = true

    await api.clear()
    await flushPromises()

    expect(siteImages.clearSiteImage).toHaveBeenCalledWith('site-1', 'favicon')
    expect(state.hasImage).toBe(false)
    expect(state.loading).toBe(0)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: `${I18N_PREFIX}ClearSuccess`
    })
  })

  it('reports a failed clear and leaves the image flag alone', async () => {
    siteImages.clearSiteImage.mockRejectedValue(new Error('Network error'))
    const { api, state } = mountComposable('favicon')
    state.hasImage = true

    await api.clear()
    await flushPromises()

    expect(state.hasImage).toBe(true)
    expect(state.loading).toBe(0)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: `${I18N_PREFIX}ClearFailed`,
      caption: 'Network error'
    })
  })
})
