import { ref } from 'vue'

import { log } from '@/helpers/log'
import { useEditorStore } from '@/stores/editor'

/**
 * Below this width (CSS px) the preview reads as broken rather than small, so dragging the divider
 * past it snaps the pane into the hidden state instead of leaving a sliver.
 */
export const PREVIEW_HIDE_THRESHOLD_PX = 100

/**
 * The floor the source pane keeps however far the divider is dragged: enough to still read a line of
 * code past Monaco's line-number gutter.
 */
export const EDITOR_MIN_WIDTH_PX = 280

/**
 * @param {object} opts
 * @param {object} opts.state The editor's reactive state bag (`previewWidth`, `previewShown`).
 * @param {{value: HTMLElement|null}} opts.previewPaneRef
 * @param {{value: HTMLElement|null}} opts.editorMidRef
 */
export function usePreviewResize({ state, previewPaneRef, editorMidRef }) {
  const editorStore = useEditorStore()

  const isDragging = ref(false)

  /*
    The active drag's scratch state: plain `let`s rather than `reactive`, since nothing here is read
    by a template.
  */
  let dragStartX = 0
  let dragStartWidthPx = 0
  /** +1 or -1: which way a growing `clientX` moves the width. */
  let dragSign = 1
  let dragMaxWidthPx = Infinity
  let previousPreviewWidth = null

  /**
   * Pointer capture keeps a fast drag tracking once the cursor leaves the divider's few px of width;
   * without it `pointermove` stops firing on this element.
   *
   * The direction a growing `clientX` moves the width is measured from where the divider actually
   * sits relative to the preview pane rather than assumed from `document.dir`: a flex-row mirror
   * under `dir="rtl"` swaps exactly that, and asking the DOM needs no parallel branch.
   */
  function onDividerPointerDown(ev) {
    if (!previewPaneRef.value || !editorMidRef.value) {
      return
    }
    ev.currentTarget.setPointerCapture(ev.pointerId)
    const previewRect = previewPaneRef.value.getBoundingClientRect()
    const midRect = editorMidRef.value.getBoundingClientRect()
    const dividerRect = ev.currentTarget.getBoundingClientRect()

    dragStartX = ev.clientX
    previousPreviewWidth = state.previewWidth
    dragStartWidthPx = state.previewWidth ?? previewRect.width
    dragSign = previewRect.left < dividerRect.left ? 1 : -1
    /*
      The two panes' current widths combined are exactly the space they have to split -- independent
      of the sidebar and the viewport, and stable for the length of one drag.
    */
    dragMaxWidthPx = Math.max(
      PREVIEW_HIDE_THRESHOLD_PX,
      midRect.width + previewRect.width - EDITOR_MIN_WIDTH_PX
    )
    isDragging.value = true
  }

  function onDividerPointerMove(ev) {
    if (!isDragging.value) {
      return
    }
    const delta = (ev.clientX - dragStartX) * dragSign
    state.previewWidth = Math.min(Math.max(dragStartWidthPx + delta, 0), dragMaxWidthPx)
  }

  /**
   * A release below the hide threshold snaps the pane shut and restores `previewWidth` to its
   * pre-drag value, so the close animation shrinks from the pane's real size and not the sliver.
   *
   * That restore is written to the DOM imperatively, in the same synchronous turn as flipping
   * `previewShown`. Reactive state alone cannot do it: once `previewShown` is false the pane's
   * `v-if` branch is gone from the new vnode tree, so Vue tears the node down at its last-rendered
   * width. Splitting the restore into its own render first (an `await nextTick()` before the flip)
   * allows a paint between the patch and the leave -- the pop-then-shut this snap exists to avoid.
   */
  function onDividerPointerUp() {
    if (!isDragging.value) {
      return
    }
    isDragging.value = false
    if (state.previewWidth < PREVIEW_HIDE_THRESHOLD_PX) {
      if (previewPaneRef.value && typeof previousPreviewWidth === 'number') {
        previewPaneRef.value.style.setProperty('--preview-width', `${previousPreviewWidth}px`)
        previewPaneRef.value.style.flex = `0 0 ${previousPreviewWidth}px`
      }
      state.previewWidth = previousPreviewWidth
      state.previewShown = false
    } else {
      persistPreviewWidth(state.previewWidth)
    }
  }

  /**
   * A full replace, merged onto `editorStore.userSettings.markdown` rather than the component's own
   * live `previewShown`/font size: those stay session-only until the settings overlay's explicit
   * Save, so writing them from here would persist a toggle the user never asked to persist.
   */
  async function persistPreviewWidth(px) {
    const payload = { ...editorStore.userSettings.markdown, previewWidth: px }
    try {
      await API_CLIENT.put('users/profile/editor-settings/markdown', {
        json: payload
      }).json()
      editorStore.$patch({
        userSettings: { ...editorStore.userSettings, markdown: payload }
      })
    } catch (err) {
      log.warn('editor', "could not save the Markdown editor's preview width", err)
    }
  }

  return { isDragging, onDividerPointerDown, onDividerPointerMove, onDividerPointerUp }
}
