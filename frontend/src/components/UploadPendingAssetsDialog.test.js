import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import UploadPendingAssetsDialog from './UploadPendingAssetsDialog.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { queue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  'editor.pendingAssetsCancel': 'Cancel Upload',
  'editor.pendingAssetsCancelled': 'Upload cancelled.'
}

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

  const i18n = createTestI18n(MESSAGES)
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

describe('UploadPendingAssetsDialog: mid-batch failure (OpenProject #945)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    queue.splice(0, queue.length)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies an already-succeeded item to the editor and prunes it from pendingAssets, even when a later item fails', async () => {
    const err = new Error('Bad Request')
    err.data = { message: 'Disk full' }
    API_CLIENT.post
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({
          ok: true,
          asset: { folderPath: '', fileName: 'one.png' }
        })
      })
      .mockReturnValueOnce({
        json: vi.fn().mockRejectedValue(err)
      })

    const reloadSpy = vi.fn()
    EVENT_BUS.on('reloadEditorContent', reloadSpy)

    const { wrapper, editorStore } = await mountDialog({
      path: 'home',
      pendingAssets: [pendingAsset('one.png'), pendingAsset('two.png')]
    })

    // -> The first item's replacement was applied to the editor's own model immediately, not
    //    batched until the (never-reached) end of the loop.
    expect(reloadSpy).toHaveBeenCalledWith({
      replacements: [{ from: 'blob:one.png', to: '/one.png' }]
    })
    // -> Pruned as it landed: only the failed item is left pending, so a retry re-uploads just that
    //    one rather than re-sending the one that already succeeded.
    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(editorStore.pendingAssets[0].fileName).toBe('two.png')
    // -> The failure path never emits `ok` -- `onDialogCancel()` only flips `dialogVisible`, so
    //    `PageHeader.vue`'s own `.onCancel(...)` handler (not this component's own emitted events)
    //    is what observes the cancellation; see `PageHeader.test.js`'s coverage of that half.
    expect(wrapper.emitted('ok')).toBeFalsy()
    expect(queue.at(-1)).toMatchObject({ type: 'negative', message: 'Disk full' })

    EVENT_BUS.off('reloadEditorContent', reloadSpy)
  })

  it("does not re-apply the failed item's own blob URL as a replacement", async () => {
    const err = new Error('Bad Request')
    err.data = { message: 'Disk full' }
    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockRejectedValue(err)
    })

    const { pageStore } = await mountDialog({
      path: 'home',
      pendingAssets: [pendingAsset('one.png')]
    })

    expect(pageStore.content).toBe('blob:one.png')
  })
})

describe('UploadPendingAssetsDialog: unbounded timeout + cancel (OpenProject #1714)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    queue.splice(0, queue.length)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts with an unbounded timeout and an AbortController signal, not the ky instance default', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({
        ok: true,
        asset: { folderPath: '', fileName: 'photo.png' }
      })
    })

    await mountDialog({
      path: 'home',
      pendingAssets: [pendingAsset('photo.png')]
    })

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/assets',
      expect.objectContaining({
        timeout: false,
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('reports a cancelled upload distinctly from a real server failure, via the Cancel button', async () => {
    // -> The mocked post never resolves on its own; the component's own `AbortController` is what
    //    ends it, by rejecting with a DOMException named AbortError, same as a real aborted `fetch`.
    let capturedSignal
    API_CLIENT.post.mockImplementationOnce((url, opts) => {
      capturedSignal = opts.signal
      return {
        json: () =>
          new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The user aborted a request.', 'AbortError'))
            })
          })
      }
    })

    const { wrapper } = await mountDialog({
      path: 'home',
      pendingAssets: [pendingAsset('big.png')]
    })

    expect(capturedSignal.aborted).toBe(false)

    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(capturedSignal.aborted).toBe(true)
    // -> Distinct from the generic negative failure toast covered by the mid-batch-failure suite
    //    above: a cancel is the user's own action, not an unexplained server error.
    expect(queue.at(-1)).toMatchObject({ type: 'warning', message: 'Upload cancelled.' })
    expect(wrapper.emitted('ok')).toBeFalsy()
  })

  it('leaves an already-uploaded item applied and pruned when a later item is cancelled', async () => {
    API_CLIENT.post
      .mockReturnValueOnce({
        json: vi.fn().mockResolvedValue({
          ok: true,
          asset: { folderPath: '', fileName: 'one.png' }
        })
      })
      .mockImplementationOnce((url, opts) => ({
        json: () =>
          new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The user aborted a request.', 'AbortError'))
            })
          })
      }))

    const { wrapper, editorStore } = await mountDialog({
      path: 'home',
      pendingAssets: [pendingAsset('one.png'), pendingAsset('two.png')]
    })

    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(editorStore.pendingAssets[0].fileName).toBe('two.png')
    expect(queue.at(-1)).toMatchObject({ type: 'warning', message: 'Upload cancelled.' })
  })
})
