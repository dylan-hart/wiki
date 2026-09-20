import { ref } from 'vue'

const DEFAULT_SELECTOR = '.w-btn'

/**
 * WAI-ARIA APG "Toolbar" roving tabindex: https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/
 *
 * The whole toolbar is ONE Tab stop -- exactly one button carries `tabindex="0"` at a time, the rest
 * `"-1"`, and arrow keys move both the focus and which button is the `"0"` -- rather than dropping
 * every button into the middle of the page's own Tab order.
 *
 * A caller wires `containerRef` onto the element wrapping the buttons, `tabindexFor(index)` onto
 * each button (a literal matching its position in the DOM, so a conditionally-rendered button takes
 * the next free index), and `onKeydown`/`onFocusin` onto the container. `tabindexFor` reads the
 * reactive `activeIndex`, so call it from inside a template expression where Vue tracks that read:
 * cached once, it freezes at whatever it first returned.
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
   * Matches the tab stop to wherever focus actually landed -- a mouse click, or Tab arriving fresh
   * -- so the next Tab out and the next arrow press continue from there, not from the first button.
   */
  function onFocusin(ev) {
    const at = items().indexOf(ev.target)
    if (at !== -1) {
      activeIndex.value = at
    }
  }

  return { activeIndex, tabindexFor, onKeydown, onFocusin }
}
