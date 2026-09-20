import { afterEach, describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'

import { useToolbarRovingTabindex } from './toolbarRovingTabindex.js'

/**
 * Plain DOM buttons rather than mounted `WBtn`s: the composable only queries `containerRef.value`
 * for the selector and calls `.focus()`, so it knows nothing about the component.
 */
function buildToolbar(count, { selector = '.w-btn' } = {}) {
  const container = document.createElement('div')
  const buttons = []
  for (let i = 0; i < count; i++) {
    const btn = document.createElement('button')
    btn.className = selector.slice(1)
    btn.textContent = `item ${i}`
    container.appendChild(btn)
    buttons.push(btn)
  }
  document.body.appendChild(container)
  return { container, buttons }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('useToolbarRovingTabindex', () => {
  it('starts with only the first item as the active tab stop', () => {
    const { container } = buildToolbar(3)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef)

    expect(roving.tabindexFor(0)).toBe(0)
    expect(roving.tabindexFor(1)).toBe(-1)
    expect(roving.tabindexFor(2)).toBe(-1)
  })

  it('ArrowRight moves focus and the active index to the next item, wrapping at the end', () => {
    const { container, buttons } = buildToolbar(3)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef)

    buttons[0].focus()
    roving.onKeydown({ key: 'ArrowRight', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[1])
    expect(roving.tabindexFor(1)).toBe(0)
    expect(roving.tabindexFor(0)).toBe(-1)

    buttons[2].focus()
    roving.onFocusin({ target: buttons[2] })
    roving.onKeydown({ key: 'ArrowRight', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[0])
    expect(roving.tabindexFor(0)).toBe(0)
  })

  it('ArrowLeft moves focus to the previous item, wrapping at the start', () => {
    const { container, buttons } = buildToolbar(3)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef)

    buttons[0].focus()
    roving.onKeydown({ key: 'ArrowLeft', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[2])
    expect(roving.tabindexFor(2)).toBe(0)
  })

  it('uses ArrowDown/ArrowUp instead of ArrowLeft/ArrowRight for a vertical toolbar', () => {
    const { container, buttons } = buildToolbar(3)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef, { orientation: 'vertical' })

    buttons[0].focus()
    roving.onKeydown({ key: 'ArrowRight', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[0])

    roving.onKeydown({ key: 'ArrowDown', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[1])

    roving.onKeydown({ key: 'ArrowUp', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[0])
  })

  it('Home and End jump to the first and last item', () => {
    const { container, buttons } = buildToolbar(4)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef)

    buttons[1].focus()
    roving.onKeydown({ key: 'End', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[3])
    expect(roving.tabindexFor(3)).toBe(0)

    roving.onKeydown({ key: 'Home', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[0])
    expect(roving.tabindexFor(0)).toBe(0)
  })

  it('calls preventDefault only for the keys it handles', () => {
    const { container } = buildToolbar(2)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef)

    let prevented = false
    roving.onKeydown({ key: 'Tab', preventDefault: () => (prevented = true) })
    expect(prevented).toBe(false)

    roving.onKeydown({ key: 'ArrowRight', preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
  })

  it('onFocusin syncs the roving index to wherever focus actually lands, e.g. a mouse click', () => {
    const { container, buttons } = buildToolbar(3)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef)

    buttons[2].focus()
    roving.onFocusin({ target: buttons[2] })
    expect(roving.tabindexFor(2)).toBe(0)
    expect(roving.tabindexFor(0)).toBe(-1)

    // -> The next arrow press continues from the clicked button, not from index 0
    roving.onKeydown({ key: 'ArrowRight', preventDefault: () => {} })
    expect(document.activeElement).toBe(buttons[0])
  })

  it('onFocusin ignores a focus event for an element outside the toolbar', () => {
    const { container } = buildToolbar(2)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef)
    const outsider = document.createElement('button')

    roving.onFocusin({ target: outsider })
    expect(roving.tabindexFor(0)).toBe(0)
  })

  it('is a no-op when the container has no items yet', () => {
    const containerRef = ref(null)
    const roving = useToolbarRovingTabindex(containerRef)

    expect(() => roving.onKeydown({ key: 'ArrowRight', preventDefault: () => {} })).not.toThrow()
    expect(roving.tabindexFor(0)).toBe(0)
  })

  it('only matches items under the given selector, ignoring unrelated descendants', async () => {
    const { container, buttons } = buildToolbar(2)
    const decoy = document.createElement('span')
    decoy.className = 'not-a-toolbar-button'
    container.appendChild(decoy)
    const containerRef = ref(container)
    const roving = useToolbarRovingTabindex(containerRef)

    buttons[0].focus()
    roving.onKeydown({ key: 'ArrowLeft', preventDefault: () => {} })
    await nextTick()
    // -> Wraps to the other real button, never lands on the decoy
    expect(document.activeElement).toBe(buttons[1])
  })
})
