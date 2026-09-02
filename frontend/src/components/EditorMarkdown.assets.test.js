import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { useEditorStore } from '@/stores/editor'
import WBtn from '@/components/shared/WBtn.vue'

import { mountWithApp } from '../../test/mount.js'
import {
  clickInsertFootnote,
  editorState,
  fakeEditor,
  mountEditorMarkdown
} from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

// -> `y-monaco` pulls in `monaco-editor/esm/vs/editor/editor.api.js` directly (not the `monaco-editor`
//    specifier mocked above), which assumes a real browser and errors under happy-dom. Never actually
//    exercised here -- live collaboration is gated on `collabEnabled`, false with no page id -- so a
//    trivial stand-in is all the module graph needs to resolve.
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const mountEditor = (initialContent) => mountEditorMarkdown(EditorMarkdown, initialContent)
/*
  `pageStore.pageSave()` (`stores/page.js`) calls `editorStore.contentFlusher()` immediately before
  reading `content`/`render`, rather than trusting whatever the debounced `onDidChangeModelContent`
  handler below has synced so far -- see that call site for why (OpenProject #806: a pasted image's
  `blob:` URL rewrite, applied straight to the Monaco model, could otherwise still be sitting in that
  500ms debounce window when a save fires). These two tests are the component-side half of that fix:
  proof the mounted editor actually registers something on `editorStore.contentFlusher`, and clears it
  again on unmount -- the store-level tests in `stores/page.test.js` only prove `pageSave()` calls
  whatever is registered, not that this component is the thing registering it.
*/
/*
  OpenProject #1889: `flushEditorContent()` used to call `processContent(value)` unconditionally on
  every 500ms debounced edit -- running the full markdown-it + KaTeX + highlight.js pipeline over the
  whole document and immediately discarding the result whenever there was no preview pane open to show
  it. These are the fix's three verification points: a closed-pane debounced flush skips the renderer
  entirely (while still syncing `pageStore.content`, so a save is never reading stale text), reopening
  the pane catches up the pending render, and the save-path flusher (`editorStore.contentFlusher`, now
  `flushEditorContentForSave`) still renders a stale document before `pageStore.pageSave()` reads
  `render` -- see that call site in `stores/page.js`.
*/
/*
  OpenProject #806 follow-up: every browser hands a clipboard-pasted file the same literal name,
  "image.png" -- so `addPendingAsset` mints a fresh unique name for a pasted `File`, but a dropped
  `File`'s name is real user intent and must stay untouched. These are the component-side proof that
  each DOM source (`onEditorPaste`'s capture-phase `paste` listener on the editor's parent, vs.
  `onEditorDrop`'s `drop` listener on the Monaco host itself) actually threads the right flag down to
  `insertFilesAsAssets` -- `stores/editor.test.js` covers the naming logic itself directly.
*/
/*
  OpenProject #804 follow-up: `onDividerPointerDown`'s `dragSign` was inverted, so dragging the
  divider toward the preview pane GREW it and dragging away SHRANK it -- backwards in both of the
  two layouts the divider has to handle (normal LTR, where the preview sits to the right of the
  divider, and an RTL mirror, where it sits to the left). These tests stand each layout up with
  mocked `getBoundingClientRect()`s (happy-dom, this workspace's Vitest environment, returns all-zero
  rects otherwise) and drag in both directions, asserting the resulting `--preview-width` moved the
  correct way in each -- rather than only re-asserting the sign formula itself, which would pass
  right back on the pre-fix code if copied from it by mistake.
*/
function mockRect(el, { left, width }) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left,
    width,
    top: 0,
    height: 0,
    right: left + width,
    bottom: 0,
    x: left,
    y: 0,
    toJSON: () => ({})
  })
}

/*
  Reads the live width the divider drag writes onto the preview pane's inline style
  (`previewInlineStyle`'s `flex: 0 0 <px>px`). happy-dom's `CSSStyleDeclaration` expands that
  shorthand into `flex-basis` (plus `flex-grow`/`flex-shrink`) when serializing the `style`
  attribute, so read the longhand rather than the shorthand written in the component.
*/
function previewFlexWidth(preview) {
  const match = preview.attributes('style')?.match(/flex-basis:\s*(\d+(?:\.\d+)?)px/)
  return match ? Number(match[1]) : null
}

async function dragDivider(wrapper, { down, move }) {
  const divider = wrapper.find('.editor-markdown-divider')
  await divider.trigger('pointerdown', { clientX: down, pointerId: 1 })
  await divider.trigger('pointermove', { clientX: move, pointerId: 1 })
  return wrapper.find('.editor-markdown-preview')
}
/*
  OpenProject #809: dragging the divider down past `PREVIEW_HIDE_THRESHOLD_PX` used to leave
  `state.previewWidth` at the tiny in-drag value for the whole close animation, only restoring the
  real pre-drag width in `onPreviewAfterLeave` -- after the pane had already finished animating shut,
  so the fix was invisible until the next open. `onDividerPointerUp` now commits the restore
  synchronously, before the close even begins.
  happy-dom implements no real CSS transitions (`getComputedStyle` reports no transition-duration),
  so the leaving element is torn down immediately rather than lingering through a `leave-active`
  state -- there is no way to assert on the pane's rendered width *during* the close animation here.
  What IS asserted, without needing a live browser: the DATA the animation would read from is correct
  by the time the pane starts leaving, proven the same way `onPreviewAfterLeave` used to prove its own
  restore worked -- reopening afterwards lands back at the pre-drag width, not the near-zero one the
  drag ended on. Whether the animation itself visually covers the right distance, with no earlier pop,
  is a live-browser concern outside what this suite can see.
*/
/*
  OpenProject #809 follow-up: `previewShown` used to start `true` (on a wide-enough viewport) before
  `onMounted` had this user's saved width back from the async settings fetch -- so the pane appeared
  instantly at the SCSS fallback (`50vw`) and snapped to the real width a moment later, rather than
  never appearing at the wrong width at all. `previewShown` now starts `false` unconditionally, and
  only opens (if it opens) once `previewWidth` is already resolved too, so the pane's one entrance this
  mount picks up the correct width from its very first frame. `previewEverRevealed` is what lets that
  first entrance use a distinct, faster transition (matching the side nav's own `0.2s` close) without
  changing the toggle-button transition a reader triggers later.
*/
/*
  OpenProject #808: both `onDidChangeModelContent` and `onDidChangeCursorPosition` are registered
  wrapped in a 500ms `debounce()`, with no reference kept to cancel either. `onBeforeUnmount` disposes
  the editor but, pre-fix, left any pending debounced call armed -- it fired ~500ms later against the
  now-disposed editor, and the cursor handler's `editor.getPosition().lineNumber` crashed because a
  disposed Monaco editor's `getPosition()` returns `null` (reproduced by `fakeEditor.getPosition`
  above via the `disposed` flag `dispose()` sets).
*/
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
})
