import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useEditorStore } from './editor.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('editor store: clearPendingAssets() (OpenProject #3554)', () => {
  it('revokes every blob URL and empties the list', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const store = useEditorStore()
    store.pendingAssets = [
      { id: 'a', kind: 'file', file: {}, fileName: 'a.png', blobUrl: 'blob:a' },
      { id: 'b', kind: 'file', file: {}, fileName: 'b.png', blobUrl: 'blob:b' }
    ]

    store.clearPendingAssets()

    expect(revoke).toHaveBeenCalledWith('blob:a')
    expect(revoke).toHaveBeenCalledWith('blob:b')
    expect(store.pendingAssets).toEqual([])
  })

  it('is a no-op on an empty list', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const store = useEditorStore()

    store.clearPendingAssets()

    expect(revoke).not.toHaveBeenCalled()
    expect(store.pendingAssets).toEqual([])
  })
})
