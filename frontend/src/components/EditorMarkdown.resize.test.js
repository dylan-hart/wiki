import { beforeEach, describe, expect, it, vi } from 'vitest'
import WBtn from '@/components/shared/WBtn.vue'

import { mountEditorMarkdown, previewFlexWidth } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

// -> `y-monaco` pulls in `monaco-editor/esm/vs/editor/editor.api.js` directly (not the `monaco-editor`
//    specifier mocked above), which assumes a real browser and errors under happy-dom. Never actually
//    exercised here -- live collaboration is gated on `collabEnabled`, false with no page id -- so a
//    trivial stand-in is all the module graph needs to resolve.
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const mountEditor = (initialContent) => mountEditorMarkdown(EditorMarkdown, initialContent)

/** Stands a real layout up for the divider drag: happy-dom returns all-zero
 *  `getBoundingClientRect()`s, so each pane's geometry has to be mocked before a drag means anything. */
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

/** Drags the divider from `down` to `move` and hands back the preview pane to assert on. */
async function dragDivider(wrapper, { down, move }) {
  const divider = wrapper.find('.editor-markdown-divider')
  await divider.trigger('pointerdown', { clientX: down, pointerId: 1 })
  await divider.trigger('pointermove', { clientX: move, pointerId: 1 })
  return wrapper.find('.editor-markdown-preview')
}

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
describe('EditorMarkdown resize divider drag direction (OpenProject #804 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /*
    Each assertion mounts its own editor: `state.previewWidth` (and so the pointer-down's own
    `dragStartWidthPx`) carries over from one drag to the next on the same instance, which would make
    a second drag's expected width depend on the first drag's result instead of the fixed 500px rect
    below -- a fresh mount is what keeps each `toBe` an easy, self-contained arithmetic check.
  */
  it('shrinks the preview when dragging toward it, in normal (preview-on-the-right) layout', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    const divider = wrapper.find('.editor-markdown-divider')
    const preview = wrapper.find('.editor-markdown-preview')

    // Normal LTR: preview sits to the right of the divider.
    mockRect(mid.element, { left: 0, width: 600 })
    mockRect(divider.element, { left: 600, width: 4 })
    mockRect(preview.element, { left: 604, width: 500 })

    // Dragging right -- toward the preview -- should shrink it.
    const updatedPreview = await dragDivider(wrapper, { down: 600, move: 650 })
    expect(previewFlexWidth(updatedPreview)).toBe(450)
  })

  it('grows the preview when dragging away from it, in normal (preview-on-the-right) layout', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    const divider = wrapper.find('.editor-markdown-divider')
    const preview = wrapper.find('.editor-markdown-preview')

    mockRect(mid.element, { left: 0, width: 600 })
    mockRect(divider.element, { left: 600, width: 4 })
    mockRect(preview.element, { left: 604, width: 500 })

    // Dragging left -- away from the preview -- should grow it.
    const updatedPreview = await dragDivider(wrapper, { down: 600, move: 550 })
    expect(previewFlexWidth(updatedPreview)).toBe(550)
  })

  it('shrinks the preview when dragging toward it, in RTL-mirrored (preview-on-the-left) layout', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    const divider = wrapper.find('.editor-markdown-divider')
    const preview = wrapper.find('.editor-markdown-preview')

    // RTL mirror: preview sits to the left of the divider.
    mockRect(preview.element, { left: 0, width: 500 })
    mockRect(divider.element, { left: 500, width: 4 })
    mockRect(mid.element, { left: 504, width: 600 })

    // Dragging left -- toward the preview -- should shrink it.
    const updatedPreview = await dragDivider(wrapper, { down: 500, move: 450 })
    expect(previewFlexWidth(updatedPreview)).toBe(450)
  })

  it('grows the preview when dragging away from it, in RTL-mirrored (preview-on-the-left) layout', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    const divider = wrapper.find('.editor-markdown-divider')
    const preview = wrapper.find('.editor-markdown-preview')

    mockRect(preview.element, { left: 0, width: 500 })
    mockRect(divider.element, { left: 500, width: 4 })
    mockRect(mid.element, { left: 504, width: 600 })

    // Dragging right -- away from the preview -- should grow it.
    const updatedPreview = await dragDivider(wrapper, { down: 500, move: 550 })
    expect(previewFlexWidth(updatedPreview)).toBe(550)
  })
})

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
describe('EditorMarkdown drag-to-hide restores the pre-drag width (OpenProject #809)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reopens at the width the pane had before the hide-drag, not the width the drag ended on', async () => {
    const { wrapper } = await mountEditor('Some text.')
    const mid = wrapper.find('.editor-markdown-mid')
    let divider = wrapper.find('.editor-markdown-divider')
    let preview = wrapper.find('.editor-markdown-preview')

    mockRect(mid.element, { left: 0, width: 600 })
    mockRect(divider.element, { left: 600, width: 4 })
    mockRect(preview.element, { left: 604, width: 500 })

    // First drag: settle the pane at a known, deliberately-large width and release ABOVE the hide
    // threshold, so it persists as `state.previewWidth` -- this is the "actual set width" the
    // second drag below must be judged against.
    preview = await dragDivider(wrapper, { down: 600, move: 650 })
    await divider.trigger('pointerup', { clientX: 650, pointerId: 1 })
    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(450)

    // Second drag: well past `PREVIEW_HIDE_THRESHOLD_PX` (100), all the way down to a sliver --
    // the drag-to-hide path.
    divider = wrapper.find('.editor-markdown-divider')
    preview = await dragDivider(wrapper, { down: 600, move: 1000 })
    expect(previewFlexWidth(preview)).toBeLessThan(100)
    await divider.trigger('pointerup', { clientX: 1000, pointerId: 1 })

    // The pane is gone -- happy-dom's leave completes immediately with no real transition to wait on.
    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(false)

    // Reopen via the toolbar's own show button. Pre-fix, this came back at whatever the drag left
    // `state.previewWidth` on (~near zero); it must instead come back at the 450px the pane actually
    // had set before this second drag started.
    const showButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'mdi:view-split-vertical')
    await showButton.trigger('click')

    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(450)
  })
})
