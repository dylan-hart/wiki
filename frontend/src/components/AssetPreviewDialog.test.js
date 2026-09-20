import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AssetPreviewDialog from './AssetPreviewDialog.vue'
import { copyToClipboard } from '@/helpers/clipboard'
import { queue as notifyQueue } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

vi.mock('@/helpers/clipboard', () => ({ copyToClipboard: vi.fn() }))

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
  notifyQueue.splice(0, notifyQueue.length)
  vi.mocked(copyToClipboard).mockReset()
  vi.restoreAllMocks()
})

async function mountDialog(props) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  const i18n = createTestI18n({
    fileman: {
      assetPreview: 'Asset Preview',
      assetPreviewImageFailed: 'This image could not be loaded.',
      assetDimensionsValue: '{width} x {height} px',
      detailsAssetDimensions: 'Dimensions',
      detailsAssetSize: 'File Size',
      detailsAssetType: 'Type',
      copyURLSuccess: 'URL has been copied to the clipboard.',
      copyURLFailed: 'Failed to copy URL to clipboard.',
      downloadFailed: 'Failed to download file.'
    },
    common: {
      actions: { copyURL: 'Copy URL', download: 'Download', close: 'Close' },
      error: { unexpected: 'Unexpected error' }
    }
  })
  currentWrapper = mount(AssetPreviewDialog, {
    props: {
      assetId: 'asset-1',
      fileName: 'photo.png',
      folderPath: 'media/2026',
      fileSize: 2048,
      mimeType: 'image/png',
      ...props
    },
    global: { plugins: [i18n] }
  })
  await flushPromises()
  return currentWrapper
}

function assetResponse(asset) {
  API_CLIENT.get.mockImplementation((url) => ({
    json: () => (asset instanceof Error ? Promise.reject(asset) : Promise.resolve(asset)),
    blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })),
    url
  }))
}

const $ = (selector) => document.body.querySelector(selector)

describe('AssetPreviewDialog', () => {
  it('shows the image from the served file URL, with its name, size and type', async () => {
    assetResponse({ id: 'asset-1' })
    await mountDialog()

    const img = $('img')
    expect(img.getAttribute('src')).toBe('/_files/media/2026/photo.png')
    expect(img.getAttribute('alt')).toBe('photo.png')
    expect($('[data-test="asset-preview-size"]').textContent).toBe('2 KB')
    expect($('[data-test="asset-preview-type"]').textContent).toBe('image/png')
  })

  it('shows the stored dimensions the Asset API returns', async () => {
    assetResponse({ id: 'asset-1', width: 640, height: 480 })
    await mountDialog()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/assets/asset-1')
    expect($('[data-test="asset-preview-dimensions"]').textContent).toBe('640 x 480 px')
  })

  it('omits the dimensions when the asset carries none', async () => {
    assetResponse({ id: 'asset-1' })
    await mountDialog()

    expect($('[data-test="asset-preview-dimensions"]')).toBeNull()
    expect($('[data-test="asset-preview-size"]')).not.toBeNull()
  })

  it('omits the dimensions, and still previews the image, when the Asset API call fails', async () => {
    assetResponse(new Error('boom'))
    await mountDialog()

    expect($('[data-test="asset-preview-dimensions"]')).toBeNull()
    expect($('img')).not.toBeNull()
    expect(notifyQueue).toHaveLength(0)
  })

  it('places a root-level file directly under the files prefix', async () => {
    assetResponse({ id: 'asset-1' })
    await mountDialog({ folderPath: '' })

    expect($('img').getAttribute('src')).toBe('/_files/photo.png')
  })

  it('replaces the image with a message when it fails to load', async () => {
    assetResponse({ id: 'asset-1' })
    await mountDialog()

    $('img').dispatchEvent(new Event('error'))
    await flushPromises()

    expect($('img')).toBeNull()
    expect($('[role="alert"]').textContent).toContain('This image could not be loaded.')
  })

  it('copies the absolute file URL and confirms', async () => {
    assetResponse({ id: 'asset-1' })
    vi.mocked(copyToClipboard).mockResolvedValue(undefined)
    await mountDialog()

    $('[data-test="asset-preview-copy"]').click()
    await flushPromises()

    expect(copyToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/_files/media/2026/photo.png`
    )
    expect(notifyQueue[0]).toMatchObject({
      type: 'positive',
      message: 'URL has been copied to the clipboard.'
    })
  })

  it('reports a failed copy', async () => {
    assetResponse({ id: 'asset-1' })
    vi.mocked(copyToClipboard).mockRejectedValue(new Error('denied'))
    await mountDialog()

    $('[data-test="asset-preview-copy"]').click()
    await flushPromises()

    expect(notifyQueue[0]).toMatchObject({
      type: 'negative',
      message: 'Failed to copy URL to clipboard.'
    })
  })

  it('downloads the asset content under its own file name', async () => {
    assetResponse({ id: 'asset-1' })
    await mountDialog()
    const created = vi.fn(() => 'blob:preview')
    const revoked = vi.fn()
    URL.createObjectURL = created
    URL.revokeObjectURL = revoked
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.download).toBe('photo.png')
      expect(this.href).toBe('blob:preview')
    })

    $('[data-test="asset-preview-download"]').click()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/assets/asset-1/content')
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(revoked).toHaveBeenCalledWith('blob:preview')
  })

  it('reports a failed download', async () => {
    assetResponse({ id: 'asset-1' })
    await mountDialog()
    API_CLIENT.get.mockImplementation(() => ({
      blob: () => Promise.reject(new Error('gone'))
    }))

    $('[data-test="asset-preview-download"]').click()
    await flushPromises()

    expect(notifyQueue[0]).toMatchObject({
      type: 'negative',
      message: 'Failed to download file.'
    })
  })
})
