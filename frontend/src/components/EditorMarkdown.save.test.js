import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeEditor, editorState, mountEditorMarkdown } from './editorMarkdownHarness.js'
import { useEditorStore } from '@/stores/editor'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

describe('EditorMarkdown Ctrl/Cmd+S action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers the save action on Ctrl/Cmd+S', async () => {
    await mountEditorMarkdown(EditorMarkdown, 'Line one.')

    const action = editorState.registeredActions.save
    expect(action.keybindings).toEqual([1 | 3])
  })

  it('asks the header for a save over the bus instead of saving itself', async () => {
    const { pageStore } = await mountEditorMarkdown(EditorMarkdown, 'Line one.')
    const requested = vi.fn()
    EVENT_BUS.on('saveShortcut', requested)
    const pageSave = vi.spyOn(pageStore, 'pageSave')

    editorState.registeredActions.save.run(fakeEditor)

    expect(requested).toHaveBeenCalledTimes(1)
    expect(pageSave).not.toHaveBeenCalled()
  })

  it('flushes a still-debounced edit first, so the header sees the pending change', async () => {
    const { pageStore } = await mountEditorMarkdown(EditorMarkdown, 'Line one.')
    const editorStore = useEditorStore()
    editorStore.$patch({ lastSaveTimestamp: 1, lastChangeTimestamp: 1 })

    let pendingAtEmit = null
    EVENT_BUS.on('saveShortcut', () => {
      pendingAtEmit = editorStore.hasPendingChanges
    })

    fakeEditor.onDidChangeModelContent.mock.calls.at(-1)[0]({})
    expect(pageStore.contentLoaded).toBe(false)

    editorState.registeredActions.save.run(fakeEditor)

    expect(pendingAtEmit).toBeTruthy()
    expect(pageStore.contentLoaded).toBe(true)
  })
})
