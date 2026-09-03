import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores/editor'
import { mountEditorMarkdown } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

// -> `y-monaco` pulls in `monaco-editor/esm/vs/editor/editor.api.js` directly (not the `monaco-editor`
//    specifier mocked above), which assumes a real browser and errors under happy-dom. Never actually
//    exercised here -- live collaboration is gated on `collabEnabled`, false with no page id -- so a
//    trivial stand-in is all the module graph needs to resolve.
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const mountEditor = (initialContent) => mountEditorMarkdown(EditorMarkdown, initialContent)

/*
  OpenProject #806 follow-up: every browser hands a clipboard-pasted file the same literal name,
  "image.png" -- so `addPendingAsset` mints a fresh unique name for a pasted `File`, but a dropped
  `File`'s name is real user intent and must stay untouched. These are the component-side proof that
  each DOM source (`onEditorPaste`'s capture-phase `paste` listener on the editor's parent, vs.
  `onEditorDrop`'s `drop` listener on the Monaco host itself) actually threads the right flag down to
  `insertFilesAsAssets` -- `stores/editor.test.js` covers the naming logic itself directly.
*/
describe('EditorMarkdown paste vs. drop file naming (OpenProject #806 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeFile(name, type = 'image/png') {
    return new File(['x'], name, { type })
  }

  it('mints distinct fileNames for two images pasted in a row, both literally named "image.png"', async () => {
    const { wrapper } = await mountEditor('')
    const editorStore = useEditorStore()
    // -> `pasteCaptureNode` in the component is `monacoRef.value.parentElement`, i.e. this wrapper div
    const editorEl = wrapper.find('.editor-markdown-editor')

    await editorEl.trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], getData: () => '' }
    })
    await editorEl.trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], getData: () => '' }
    })

    expect(editorStore.pendingAssets).toHaveLength(2)
    const [first, second] = editorStore.pendingAssets
    expect(first.fileName).not.toBe('image.png')
    expect(second.fileName).not.toBe('image.png')
    expect(first.fileName).not.toBe(second.fileName)
  })

  it("preserves a dropped file's real name unchanged -- no regression from the paste fix", async () => {
    const { wrapper } = await mountEditor('')
    const editorStore = useEditorStore()
    // -> The `drop` listener is on `monacoRef.value` itself, the inner unclassed div
    const dropTarget = wrapper.find('.editor-markdown-editor div')

    await dropTarget.trigger('drop', {
      dataTransfer: { files: [makeFile('quarterly-report.pdf', 'application/pdf')] },
      clientX: 0,
      clientY: 0
    })

    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(editorStore.pendingAssets[0].fileName).toBe('quarterly-report.pdf')
  })

  /*
    OpenProject #2450: the cross-browser gap this fork's editor-hardening pass left open was whether
    `clipboardData.files` is actually populated for an OS-clipboard image paste in every engine. This
    proves the defensive fallback -- `pastedFiles()` reading `.items` when `.files` comes back empty --
    is really wired into the capture-phase paste listener, not just available as an unused helper: a
    paste whose `clipboardData` carries no `.files` at all, only an `.items` list, still inserts the
    image as a pending asset instead of silently no-opping.
  */
  it('still inserts a pasted image when `clipboardData.files` is empty but `.items` carries it', async () => {
    const { wrapper } = await mountEditor('')
    const editorStore = useEditorStore()
    const editorEl = wrapper.find('.editor-markdown-editor')
    const image = makeFile('image.png')

    await editorEl.trigger('paste', {
      clipboardData: {
        files: [],
        items: [{ kind: 'file', getAsFile: () => image }],
        getData: () => ''
      }
    })

    expect(editorStore.pendingAssets).toHaveLength(1)
    expect(editorStore.pendingAssets[0].kind).toBe('file')
    expect(editorStore.pendingAssets[0].file.type).toBe('image/png')
  })
})
