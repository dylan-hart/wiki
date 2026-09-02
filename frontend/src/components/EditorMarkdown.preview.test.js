import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { useEditorStore } from '@/stores/editor'
import WBtn from '@/components/shared/WBtn.vue'

import { mountWithApp } from '../../test/mount.js'
import {
  editorState,
  fakeEditor,
  mountEditorMarkdown,
  previewFlexWidth
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
describe('EditorMarkdown skips rendering while the preview pane is closed (OpenProject #1889)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function closePreview(wrapper) {
    const hideButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:eye-off-outline')
    await hideButton.trigger('click')
  }

  it('does not run the renderer on a debounced edit while the pane is closed', async () => {
    const { wrapper, pageStore } = await mountEditor('Initial content.')
    await closePreview(wrapper)
    // -> `md` is only assigned once `onMounted` resolves (see `mountEditor`'s own comment on why this
    //    test file mounts the real markdown pipeline rather than stubbing it out)
    const renderSpy = vi.spyOn(wrapper.vm.md, 'render')

    editorState.fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'EDITED '
    })
    // -> The handler `onDidChangeModelContent` was registered with -- same as the OpenProject #808
    //    tests above use to arm the debounce
    const contentChangeHandler = fakeEditor.onDidChangeModelContent.mock.calls[0][0]
    contentChangeHandler({})
    vi.advanceTimersByTime(500)

    // -> Content still syncs on every debounced edit -- a save must never read stale `content`
    expect(pageStore.content).toContain('EDITED')
    // -> But the render pipeline itself never ran, and the flag records the render this owes
    expect(renderSpy).not.toHaveBeenCalled()
    expect(wrapper.vm.state.renderIsStale).toBe(true)
  })

  it('renders the pending content once the preview pane is reopened', async () => {
    const { wrapper, pageStore } = await mountEditor('Initial content.')
    await closePreview(wrapper)

    editorState.fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'EDITED '
    })
    const contentChangeHandler = fakeEditor.onDidChangeModelContent.mock.calls[0][0]
    contentChangeHandler({})
    vi.advanceTimersByTime(500)
    expect(wrapper.vm.state.renderIsStale).toBe(true)

    const showButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:view-split-vertical')
    await showButton.trigger('click')

    expect(pageStore.render).toContain('EDITED')
    expect(wrapper.vm.state.renderIsStale).toBe(false)
  })

  it('the save-path flusher renders a stale document before pageSave reads pageStore.render', async () => {
    const { wrapper, pageStore } = await mountEditor('Initial content.')
    const editorStore = useEditorStore()
    await closePreview(wrapper)
    const renderBeforeEdit = pageStore.render

    editorState.fakeModel.applyEdit({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'SAVE-PATH-EDIT '
    })

    // -> What `pageStore.pageSave()` calls synchronously before it reads `render` -- proves the save
    //    path renders even with nothing yet flushed through the debounced handler: the flusher itself
    //    both syncs `content` from the live editor value and, because the pane is closed, catches up
    //    the render too -- unlike the plain debounced flush the first test above covers.
    editorStore.contentFlusher()

    expect(pageStore.content).toContain('SAVE-PATH-EDIT')
    expect(pageStore.render).not.toBe(renderBeforeEdit)
    expect(pageStore.render).toContain('SAVE-PATH-EDIT')
    expect(wrapper.vm.state.renderIsStale).toBe(false)
  })
})

describe('EditorMarkdown preview pane initial reveal (OpenProject #809 follow-up)', () => {
  it('does not start with the preview already shown -- it opens only once mount has resolved', () => {
    const { wrapper } = mountWithApp(EditorMarkdown)

    // -> Synchronously, before `onMounted`'s awaited settings fetch has had any chance to resolve.
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(false)
    expect(wrapper.vm.previewEverRevealed).toBe(false)
  })

  it('marks the pane as having revealed once mount settles, and keeps it marked across a later toggle', async () => {
    const { wrapper } = await mountEditor('Some text.')

    // -> The one entrance this mount has already happened by the time `mountEditor` returns (it awaits
    //    `flushPromises`, which settles the `nextTick` this flag is set in) -- so it reads `true` here,
    //    not because this test caught it mid-animation.
    expect(wrapper.vm.previewEverRevealed).toBe(true)
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(true)

    // -> Hide and reshow via the toolbar buttons. This is the toggle-button path the ORIGINAL
    //    `editor-markdown-preview` transition (unchanged, 0.5s) still owns -- proving the flag does not
    //    reset is what proves this fix cannot regress that already-verified behavior.
    const hideButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:eye-off-outline')
    await hideButton.trigger('click')
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(false)
    expect(wrapper.vm.previewEverRevealed).toBe(true)

    const showButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:view-split-vertical')
    await showButton.trigger('click')
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(true)
    expect(wrapper.vm.previewEverRevealed).toBe(true)
  })

  it("uses App.vue's prefetched settings instead of fetching again, when already cached", async () => {
    let fetchUserSettings
    const { wrapper } = mountWithApp(EditorMarkdown, {
      stores: {
        editor: (store) => {
          // -> Standing in for App.vue's own prefetch (OpenProject #809 follow-up) having already
          //    landed by the time this component mounts -- the normal case, not a special setup for
          //    this test alone. Seeded (and spied) inside the seed callback, which `mountWithApp`
          //    runs before the component mounts.
          store.userSettings.markdown = { previewShown: true, previewWidth: 725 }
          fetchUserSettings = vi.spyOn(store, 'fetchUserSettings')
        }
      }
    })
    await flushPromises()

    expect(fetchUserSettings).not.toHaveBeenCalled()
    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(725)
  })

  it('falls back to fetching directly when nothing was prefetched (e.g. a guest who just signed in)', async () => {
    let fetchUserSettings
    const { wrapper } = mountWithApp(EditorMarkdown, {
      stores: {
        editor: (store) => {
          fetchUserSettings = vi
            .spyOn(store, 'fetchUserSettings')
            .mockResolvedValue({ previewShown: true, previewWidth: 725 })
        }
      }
    })
    await flushPromises()

    expect(fetchUserSettings).toHaveBeenCalledWith('markdown')
    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(725)
  })
})
