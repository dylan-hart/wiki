import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeEditor, mountEditorMarkdown } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

// -> `y-monaco` pulls in `monaco-editor/esm/vs/editor/editor.api.js` directly (not the `monaco-editor`
//    specifier mocked above), which assumes a real browser and errors under happy-dom. Never actually
//    exercised here -- live collaboration is gated on `collabEnabled`, false with no page id -- so a
//    trivial stand-in is all the module graph needs to resolve.
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const mountEditor = (initialContent) => mountEditorMarkdown(EditorMarkdown, initialContent)

/*
  OpenProject #808: both `onDidChangeModelContent` and `onDidChangeCursorPosition` are registered
  wrapped in a 500ms `debounce()`, with no reference kept to cancel either. `onBeforeUnmount` disposes
  the editor but, pre-fix, left any pending debounced call armed -- it fired ~500ms later against the
  now-disposed editor, and the cursor handler's `editor.getPosition().lineNumber` crashed because a
  disposed Monaco editor's `getPosition()` returns `null` (reproduced by `fakeEditor.getPosition` in
  `editorMarkdownHarness.js`, via the `editorState.disposed` flag its `dispose()` sets).
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

    // -> The handler `onDidChangeCursorPosition` was registered with -- the debounced wrapper itself,
    //    same as a real Monaco `onDidChangeCursorPosition(cb)` call would invoke on every move.
    const cursorPositionHandler = fakeEditor.onDidChangeCursorPosition.mock.calls[0][0]
    cursorPositionHandler({}) // -> arms the 500ms debounce, same as an author moving the caret

    // -> Mount itself already called `getPosition()` once (the initial preview-tab sync) -- captured
    //    here so the assertion below is about calls from AFTER unmount, not this legitimate earlier one.
    const getPositionCallsAtUnmount = fakeEditor.getPosition.mock.calls.length
    wrapper.unmount()

    // -> Pre-fix, this throws: the debounce fires here, `getPosition()` returns `null` (disposed),
    //    and reading `.lineNumber` off it throws "Cannot read properties of null (reading
    //    'lineNumber')" -- the exact crash from the ticket.
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    // -> Confirms *why* it didn't throw: the debounced call was cancelled, not merely lucky timing --
    //    no NEW call to `getPosition()` happened once the timer was advanced.
    expect(fakeEditor.getPosition.mock.calls.length).toBe(getPositionCallsAtUnmount)
  })

  it('cancels a pending content-change debounce on unmount, so it never re-reads the disposed editor', async () => {
    const { wrapper } = await mountEditor('Line one.')

    const contentChangeHandler = fakeEditor.onDidChangeModelContent.mock.calls[0][0]
    contentChangeHandler({}) // -> arms the 500ms debounce, same as an author typing a keystroke

    // -> `flushEditorContent` (what the debounced handler calls) reads `editor.getValue()` -- captured
    //    here the same way `getPositionCallsAtUnmount` is above, so the assertion below is about calls
    //    from AFTER unmount, not any legitimate earlier one.
    const getValueCallsAtUnmount = fakeEditor.getValue.mock.calls.length
    wrapper.unmount()

    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    // -> Pre-fix, this call count DOES advance: the debounce still fires post-dispose and re-reads
    //    `editor.getValue()`, which is the other half of the ticket's "leaves a blank page until
    //    refresh" symptom -- a disposed Monaco editor's `getValue()` no longer reflects the document,
    //    so that stale/empty read would land straight in `pageStore.content`.
    expect(fakeEditor.getValue.mock.calls.length).toBe(getValueCallsAtUnmount)
  })
})

/*
 * Mount-time `editor.focus()` (`// -> Post init`) used to run unconditionally, which raced an
 * author who clicked into the page Title field (`PageHeader.vue`'s contenteditable -- it has no
 * autofocus of its own) and started typing before Monaco's async `onMounted` -- it awaits a
 * settings/site-blocks prefetch before ever creating the editor -- had finished: the moment Monaco
 * mounted, its focus() call stole focus mid-type, and every keystroke meant for the title landed in
 * the editor instead, leaving the title empty. Caught by the Playwright smoke suite's
 * `page-publish.spec.js`, which types the title and blurs it well before this component's async
 * mount settles on a loaded CI runner.
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
