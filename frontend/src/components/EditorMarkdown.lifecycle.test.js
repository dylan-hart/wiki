import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeEditor, mountEditorMarkdown } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const mountEditor = (initialContent) => mountEditorMarkdown(EditorMarkdown, initialContent)

/*
  `onDidChangeModelContent` and `onDidChangeCursorPosition` are both registered wrapped in a 500ms
  `debounce()`. A call left armed when `onBeforeUnmount` disposes the editor fires ~500ms later
  against it, where a disposed Monaco editor's `getPosition()` returns `null` -- reproduced by
  `fakeEditor.getPosition` in `editorMarkdownHarness.js`, via the `editorState.disposed` flag.
*/
describe('EditorMarkdown debounced handler cleanup on unmount (OpenProject #808)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels a pending cursor-position debounce on unmount, so it never fires against the disposed editor', async () => {
    const { wrapper } = await mountEditor('Line one.\nLine two.\nLine three.')

    const cursorPositionHandler = fakeEditor.onDidChangeCursorPosition.mock.calls[0][0]
    cursorPositionHandler({}) // -> arms the 500ms debounce, same as an author moving the caret

    // -> Mount already called `getPosition()` once (the initial preview-tab sync), so the assertion
    //    below is about calls from AFTER unmount rather than that legitimate earlier one.
    const getPositionCallsAtUnmount = fakeEditor.getPosition.mock.calls.length
    wrapper.unmount()

    // -> An uncancelled debounce fires here, `getPosition()` returns `null` on the disposed editor,
    //    and reading `.lineNumber` off it throws.
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    // -> Cancelled, not merely lucky timing: no NEW `getPosition()` call once the timer advanced.
    expect(fakeEditor.getPosition.mock.calls.length).toBe(getPositionCallsAtUnmount)
  })

  it('cancels a pending content-change debounce on unmount, so it never re-reads the disposed editor', async () => {
    const { wrapper } = await mountEditor('Line one.')

    const contentChangeHandler = fakeEditor.onDidChangeModelContent.mock.calls[0][0]
    contentChangeHandler({}) // -> arms the 500ms debounce, same as an author typing a keystroke

    // -> `flushEditorContent` reads `editor.getValue()`; captured so the assertion below is about
    //    calls from AFTER unmount rather than any legitimate earlier one.
    const getValueCallsAtUnmount = fakeEditor.getValue.mock.calls.length
    wrapper.unmount()

    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    // -> An uncancelled debounce re-reads `editor.getValue()` post-dispose, where it no longer
    //    reflects the document, and that stale read lands straight in `pageStore.content`.
    expect(fakeEditor.getValue.mock.calls.length).toBe(getValueCallsAtUnmount)
  })
})

/*
 * Mount-time `editor.focus()` is conditional because Monaco's `onMounted` awaits a
 * settings/site-blocks prefetch before creating the editor: an unconditional focus lands after an
 * author has already clicked into the page Title field (`PageHeader.vue`'s contenteditable, which
 * has no autofocus of its own) and started typing, sending every keystroke to the editor instead.
 */

describe('EditorMarkdown does not steal focus already given to another field on mount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('focuses itself when nothing else has focus yet, matching the previous default', async () => {
    const { wrapper } = await mountEditor('')
    expect(fakeEditor.focus).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('leaves focus alone when another field was already focused before mount finished', async () => {
    const titleInput = document.createElement('input')
    document.body.appendChild(titleInput)
    titleInput.focus()

    const { wrapper } = await mountEditor('')

    expect(fakeEditor.focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(titleInput)
    wrapper.unmount()
  })
})
