import { beforeEach, describe, expect, it, vi } from 'vitest'
import WBtn from '@/components/shared/WBtn.vue'

import { mountEditorMarkdown, previewFlexWidth } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

const mountEditor = (initialContent) => mountEditorMarkdown(EditorMarkdown, initialContent)

/** happy-dom returns all-zero `getBoundingClientRect()`s, so each pane's geometry has to be mocked
 *  before a drag means anything. */
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

async function dragDivider(wrapper, { down, move }) {
  const divider = wrapper.find('.editor-markdown-divider')
  await divider.trigger('pointerdown', { clientX: down, pointerId: 1 })
  await divider.trigger('pointermove', { clientX: move, pointerId: 1 })
  return wrapper.find('.editor-markdown-preview')
}

/*
  The divider has to handle two layouts -- normal LTR, preview to the right of the divider, and an
  RTL mirror, preview to the left -- and `dragSign` must come out the right way round in both. Each
  layout is stood up with mocked rects and dragged both ways, asserting the pane's resulting width
  rather than the sign formula itself, which an inverted implementation would satisfy too.
*/
describe('EditorMarkdown resize divider drag direction (OpenProject #804 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /*
    Each assertion mounts its own editor: `state.previewWidth` (and so `dragStartWidthPx`) carries
    over from one drag to the next on the same instance, which would make a second drag's expected
    width depend on the first drag's result instead of the fixed 500px rect below.
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

    const updatedPreview = await dragDivider(wrapper, { down: 500, move: 550 })
    expect(previewFlexWidth(updatedPreview)).toBe(550)
  })
})

/*
  Dragging past `PREVIEW_HIDE_THRESHOLD_PX` hides the pane, and `onDividerPointerUp` restores the
  pre-drag width synchronously, before the close begins, so the animation reads the right distance.
  happy-dom implements no real CSS transitions, so a leaving element is torn down immediately rather
  than lingering through `leave-active`: the rendered width *during* the close cannot be asserted
  here, only that reopening lands back at the pre-drag width and not the near-zero one.
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

    // First drag: settle at a known width, released ABOVE the hide threshold so it persists as
    // `state.previewWidth` -- the width the second drag must be judged against.
    preview = await dragDivider(wrapper, { down: 600, move: 650 })
    await divider.trigger('pointerup', { clientX: 650, pointerId: 1 })
    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(450)

    // Second drag: well past `PREVIEW_HIDE_THRESHOLD_PX`, down to a sliver -- the drag-to-hide path.
    divider = wrapper.find('.editor-markdown-divider')
    preview = await dragDivider(wrapper, { down: 600, move: 1000 })
    expect(previewFlexWidth(preview)).toBeLessThan(100)
    await divider.trigger('pointerup', { clientX: 1000, pointerId: 1 })

    expect(wrapper.find('.editor-markdown-preview').exists()).toBe(false)

    // Reopen via the toolbar's show button: it must come back at the 450px the pane had set before
    // the second drag, not the near-zero width that drag ended on.
    const showButton = wrapper
      .findAllComponents(WBtn)
      .find((candidate) => candidate.props('icon') === 'tabler:layout-columns')
    await showButton.trigger('click')

    expect(previewFlexWidth(wrapper.find('.editor-markdown-preview'))).toBe(450)
  })
})
