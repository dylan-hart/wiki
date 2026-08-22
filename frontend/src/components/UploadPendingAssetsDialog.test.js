import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import UploadPendingAssetsDialog from './UploadPendingAssetsDialog.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/**
 * The component's own `onMounted` (not `useDialogComponent`'s) awaits a fixed 500ms delay before
 * uploading anything -- fake timers stand in for that, same as `EditorMarkdown.test.js`'s debounce
 * suite, so a test does not actually wait half a second per case.
 */
async function mountDialog({ path, pendingAssets }) {
  setActivePinia(createPinia())
  const editorStore = useEditorStore()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()

  siteStore.id = 'site-1'
  pageStore.path = path
  pageStore.content = pendingAssets.map((a) => a.blobUrl).join('\n')
  editorStore.pendingAssets = pendingAssets

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  const wrapper = mount(UploadPendingAssetsDialog, {
    global: { plugins: [i18n], stubs: { teleport: true } }
  })

  await vi.advanceTimersByTimeAsync(500)
  await flushPromises()

  return { wrapper, editorStore, pageStore, siteStore }
}

function pendingAsset(fileName) {
  return {
    id: fileName,
    kind: 'file',
    file: { name: fileName, type: 'image/png' },
    fileName,
    blobUrl: `blob:${fileName}`
  }
}

describe('UploadPendingAssetsDialog: destination folder (OpenProject #879)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("uploads into the page's own parent folder, not the asset root", async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        asset: { folderPath: 'guides/setup', fileName: 'photo.png' }
      })
    })

    const { siteStore } = await mountDialog({
      path: 'guides/setup/my-page',
      pendingAssets: [pendingAsset('photo.png')]
    })

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${siteStore.id}/assets`,
      expect.objectContaining({
        searchParams: { fileName: 'photo.png', parentPath: 'guides/setup' }
      })
    )
  })

  it('sends an empty parentPath for a root-level page, unchanged from asset-root behavior', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        asset: { folderPath: '', fileName: 'photo.png' }
      })
    })

    const { siteStore } = await mountDialog({
      path: 'home',
      pendingAssets: [pendingAsset('photo.png')]
    })

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${siteStore.id}/assets`,
      expect.objectContaining({
        searchParams: { fileName: 'photo.png', parentPath: '' }
      })
    )
  })

  it('replaces the blob URL with the path the server actually stored, and closes the dialog', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        asset: { folderPath: 'guides/setup', fileName: 'photo-1.png' }
      })
    })

    const { wrapper, pageStore } = await mountDialog({
      path: 'guides/setup/my-page',
      pendingAssets: [pendingAsset('photo.png')]
    })

    expect(pageStore.content).toBe('/guides/setup/photo-1.png')
    expect(wrapper.emitted('ok')).toBeTruthy()
  })
})
