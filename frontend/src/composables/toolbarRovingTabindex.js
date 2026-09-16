import { ref } from 'vue'

const DEFAULT_SELECTOR = '.w-btn'

/**
 * WAI-ARIA APG "Toolbar" roving-tabindex behavior (Task/Feature #3350):
 * https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/
 *
 * A toolbar full of individually-focusable buttons is one Tab stop per button, which puts every one
 * of them in the middle of the page's own Tab order -- for `EditorMarkdown.vue`'s two toolbars, that
 * meant Tab from the page description landed on ten (or a dozen) toolbar buttons before it ever
 * reached the content it was editing. Roving tabindex turns the whole toolbar into ONE Tab stop
 * instead: exactly one of its buttons carries `tabindex="0"` at a time (the rest carry `"-1"`, still
 * focusable by click but out of the Tab sequence), and once focus is inside the toolbar, arrow keys
 * move both the real focus and which button is the `"0"` -- so every button stays fully reachable
 * from the keyboard, just not via repeated Tab presses.
 *
 * Queries the DOM at event time through `containerRef` rather than keeping a parallel array of
 * per-button refs, the same style `WTabs.vue`'s own arrow-key roving and `WMenu.vue`'s panel roving
 * already use. A caller wires three things onto its markup: `containerRef` on the element wrapping
 * the buttons, `tabindexFor(index)` on each button (a literal per button, matching its position in
 * the DOM -- a conditionally-rendered button simply takes the next free index), and `onKeydown` /
 * `onFocusin` on the container itself.
 *
 * `tabindexFor` reads the reactive `activeIndex` ref directly, so it is meant to be called from
 * inside a template expression (`:tabindex="roving.tabindexFor(0)"`) where Vue's own reactivity
 * tracks that read -- not cached once and reused, which would freeze it at whatever it returned the
 * first time.
 */
export function useToolbarRovingTabindex(
  containerRef,
  { orientation = 'horizontal', selector = DEFAULT_SELECTOR } = {}
) {
  const activeIndex = ref(0)

  function items() {
    return containerRef.value ? Array.from(containerRef.value.querySelectorAll(selector)) : []
  }

  function tabindexFor(index) {
    return activeIndex.value === index ? 0 : -1
  }

  function focusItemAt(index, list) {
    const target = list[index]
    if (!target) {
      return
    }
    activeIndex.value = index
    target.focus()
  }

  const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight'
  const prevKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft'

  /** Arrow/Home/End navigation, wrapping at both ends. Any other key is left alone. */
  function onKeydown(ev) {
    if (![nextKey, prevKey, 'Home', 'End'].includes(ev.key)) {
      return
    }
    const list = items()
    if (list.length === 0) {
      return
    }
    ev.preventDefault()
    const at = list.indexOf(document.activeElement)
    let next
    if (ev.key === 'Home') {
      next = 0
    } else if (ev.key === 'End') {
      next = list.length - 1
    } else if (ev.key === nextKey) {
      next = at === -1 ? 0 : (at + 1) % list.length
    } else {
      next = at === -1 ? list.length - 1 : (at - 1 + list.length) % list.length
    }
    focusItemAt(next, list)
  }

  /**
   * Keeps the roving tab stop matched to wherever focus actually lands -- a mouse click, or Tab
   * arriving fresh -- so the next Tab out of the toolbar, and the next arrow press into it, both
   * continue from there rather than silently snapping back to the first button.
   */
  function onFocusin(ev) {
    const at = items().indexOf(ev.target)
    if (at !== -1) {
      activeIndex.value = at
    }
  }

  return { activeIndex, tabindexFor, onKeydown, onFocusin }
}
