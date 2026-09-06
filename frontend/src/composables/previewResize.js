import { ref } from 'vue'

import { log } from '@/helpers/log'
import { useEditorStore } from '@/stores/editor'

/**
 * Below this width (CSS px) the preview pane reads as broken rather than "small" -- dragging the
 * divider past this point snaps it into the existing hidden state instead of leaving an awkward
 * sliver. Picked from the middle of a reasonable 80-150px range: narrow enough that a deliberately
 * small-but-legible preview is still reachable before the snap, wide enough that "keep dragging and
 * it vanishes" reads as an intentional threshold rather than the pane getting stuck.
 */
export const PREVIEW_HIDE_THRESHOLD_PX = 100

/**
 * The source pane never gives up more than this many px to the preview, however far the divider is
 * dragged. 280px is comfortably enough to still read a line of code past Monaco's line-number
 * gutter, and clamping here means every width check below only has to bound the preview's own
 * maximum, not chase "how small can the editor get" as a separate calculation.
 */
export const EDITOR_MIN_WIDTH_PX = 280

/**
 * The markdown editor's preview-pane resize divider: the whole drag, from pointer-down to the width
 * being persisted (or the pane snapping shut).
 *
 * `EditorMarkdown.vue` keeps the two panes' template refs and its own `state` -- the divider only
 * reads and writes `state.previewWidth` / `state.previewShown`, which the pane's own styles and
 * transitions are already driven from -- so those are passed in rather than owned here.
 *
 * @param {object} opts
 * @param {object} opts.state The editor's reactive state bag (`previewWidth`, `previewShown`).
 * @param {{value: HTMLElement|null}} opts.previewPaneRef
 * @param {{value: HTMLElement|null}} opts.editorMidRef
 */
export function usePreviewResize({ state, previewPaneRef, editorMidRef }) {
  const editorStore = useEditorStore()

  /** Whether the resize divider is currently being dragged -- drives its highlight and the app-wide cursor/selection lockdown while dragging (`.is-resizing` on the component root). */
  const isDragging = ref(false)

  /*
    The active drag's own scratch state. Plain `let`s rather than `reactive`, matching `editor`/`md`/
    `siteBlocks` in the component -- nothing here is read by the template directly
    (`state.previewWidth` and `isDragging` are what render), so there is nothing reactivity would buy.
  */
  /** Pointer clientX at the drag's start. */
  let dragStartX = 0
  /** `state.previewWidth` resolved to a concrete px number at the drag's start -- see `onDividerPointerDown`. */
  let dragStartWidthPx = 0
  /** +1 or -1: which way a growing `clientX` should move the width, measured fresh each drag (see `onDividerPointerDown`'s doc comment for why). */
  let dragSign = 1
  /** The most the preview may grow to in this drag, measured once at pointer-down (see `onDividerPointerDown`). */
  let dragMaxWidthPx = Infinity
  /** `state.previewWidth` as it was immediately before this drag began -- what a hide-snap restores. */
  let previousPreviewWidth = null

  /**
   * Pointer-down on the resize divider: begins tracking a drag, VS Code pane-resize style -- live
   * visual tracking on move (`onDividerPointerMove`), committed on release (`onDividerPointerUp`).
   *
   * Pointer capture is what lets a fast drag keep tracking correctly even once the pointer has moved
   * off the (deliberately narrow) divider itself and over the editor or preview pane -- without it,
   * `pointermove` would stop firing on this element the moment the cursor left its few px of width.
   *
   * The direction a growing `clientX` should move the width in is measured fresh from where the
   * divider actually sits relative to the preview pane, rather than assumed from `document.dir` the
   * way `sideToolbarTooltip` in the component does for a fixed anchor -- a resize divider's physical
   * side of its pane is exactly what a flex-row mirror under `dir="rtl"` swaps, so asking the DOM
   * directly is what keeps this correct in both directions without a parallel branch to keep in sync.
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
      Both panes' current widths, combined, are exactly the space the two of them have to split between
      them -- independent of the sidebar or the viewport, and stable for the length of one drag (the
      window is not expected to be resized mid-drag).
    */
    dragMaxWidthPx = Math.max(
      PREVIEW_HIDE_THRESHOLD_PX,
      midRect.width + previewRect.width - EDITOR_MIN_WIDTH_PX
    )
    isDragging.value = true
  }

  /** Live drag tracking: applies the new width immediately, clamped to this drag's own bounds. */
  function onDividerPointerMove(ev) {
    if (!isDragging.value) {
      return
    }
    const delta = (ev.clientX - dragStartX) * dragSign
    state.previewWidth = Math.min(Math.max(dragStartWidthPx + delta, 0), dragMaxWidthPx)
  }

  /**
   * Pointer-up (or -cancel): commits the drag.
   *
   * A release at or above the hide threshold persists the new width. A release below it hands off to
   * the existing hidden state (the same `previewShown = false` the toolbar's own hide button sets)
   * instead of leaving an awkward sliver, restoring `previewWidth` to the width the pane actually had
   * before this drag (`previousPreviewWidth`) rather than leaving it at the small in-drag value --
   * otherwise the close animation would shrink from that sliver instead of the pane's real size.
   *
   * That restore is written to the DOM directly, synchronously, in the same turn as flipping
   * `previewShown` -- not through the reactive `state.previewWidth` binding a moment earlier, and not
   * deferred to after the close transition (`@after-leave`) the way this used to work. Two things rule
   * those out:
   *
   * - Writing `state.previewWidth` here and letting Vue's own render pick it up does nothing for the
   *   *leaving* element: once `previewShown` is false in the same update, the pane's `v-if` branch is
   *   absent from the new vnode tree, so Vue never re-patches its style from the new state -- it just
   *   tears down the DOM node as last rendered (still at the small in-drag width). Deferring the
   *   restore to `@after-leave` used to work around exactly that, at the cost of the underlying value
   *   staying wrong, invisibly, for the whole close animation.
   * - Splitting the restore into its own render first (e.g. an `await nextTick()` before the flip)
   *   would let Vue patch the big width onto the still-open pane, but does not guarantee no paint lands
   *   between that patch and the leave starting -- which would show the exact pop-then-shut this snap
   *   exists to avoid: a static hold at the full width before it starts shrinking.
   *
   * Setting the inline style imperatively and flipping `previewShown` in the same synchronous call
   * sidesteps both: the DOM already reflects the real width by the time Vue's `<transition>` captures
   * its leave-active starting point, with no intervening render for the browser to paint.
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
   * Saves this user's chosen preview width the same way `EditorMarkdownUserSettingsOverlay` saves font
   * size and preview-shown -- a full replace of `users/profile/editor-settings/markdown` (see that
   * overlay's `save()`).
   *
   * The merge base is `editorStore.userSettings.markdown`, not the component's own live `previewShown`
   * / font size: those are session-only there (the editor never saves either on its own, only the
   * settings overlay's explicit Save does), so writing them out from this path would start silently
   * persisting a toggle the user never asked to persist. `fetchUserSettings` populates the store field
   * on mount, and the settings overlay patches it too on its own successful save, so either order --
   * drag then open settings, or open settings then drag -- reads the other's latest write rather than
   * stomping it.
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
