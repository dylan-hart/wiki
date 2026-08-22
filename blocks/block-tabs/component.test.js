import { afterEach, describe, expect, it } from 'vitest'

import '../block-tab/component.js'
import './component.js'

/** Builds `<block-tabs>` around N `<block-tab>` panels, the shape the block reads from its light DOM. */
async function mountTabs(panels, attrs = {}) {
  const el = document.createElement('block-tabs')
  for (const [key, value] of Object.entries(attrs)) {
    el[key] = value
  }
  for (const { label, content } of panels) {
    const tab = document.createElement('block-tab')
    tab.setAttribute('label', label)
    tab.innerHTML = `<p>${content}</p>`
    el.appendChild(tab)
  }
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

function stripButtons(el) {
  return [...el.shadowRoot.querySelectorAll('.tab')]
}

describe('block-tabs', () => {
  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
  })

  it('builds the strip from each panel’s label and shows only the first panel', async () => {
    const el = await mountTabs([
      { label: 'First', content: 'One' },
      { label: 'Second', content: 'Two' }
    ])

    expect(stripButtons(el).map((b) => b.textContent.trim())).toEqual(['First', 'Second'])
    const panels = [...el.querySelectorAll('block-tab')]
    expect(panels[0].style.display).toBe('block')
    expect(panels[1].style.display).toBe('none')
  })

  it('falls back to "Tab N" for a panel with no label', async () => {
    const el = await mountTabs([{ label: '', content: 'One' }])
    expect(stripButtons(el)[0].textContent.trim()).toBe('Tab 1')
  })

  it('switches the visible panel on a strip click', async () => {
    const el = await mountTabs([
      { label: 'First', content: 'One' },
      { label: 'Second', content: 'Two' }
    ])

    stripButtons(el)[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await el.updateComplete

    const panels = [...el.querySelectorAll('block-tab')]
    expect(panels[0].style.display).toBe('none')
    expect(panels[1].style.display).toBe('block')
    expect(stripButtons(el)[1].classList.contains('is-active')).toBe(true)
  })

  it('respects an initial active index set as a property', async () => {
    const el = await mountTabs(
      [
        { label: 'First', content: 'One' },
        { label: 'Second', content: 'Two' }
      ],
      { active: 1 }
    )

    const panels = [...el.querySelectorAll('block-tab')]
    expect(panels[1].style.display).toBe('block')
    expect(stripButtons(el)[1].getAttribute('aria-selected')).toBe('true')
  })

  it('clamps an out-of-range active index into a valid tab instead of hiding every panel', async () => {
    const el = await mountTabs(
      [
        { label: 'First', content: 'One' },
        { label: 'Second', content: 'Two' }
      ],
      { active: 99 }
    )

    const panels = [...el.querySelectorAll('block-tab')]
    // -> Clamped to the last real tab, not left pointing past the end
    expect(panels[1].style.display).toBe('block')
    expect(stripButtons(el).some((b) => b.classList.contains('is-active'))).toBe(true)
  })

  it('moves the active tab with ArrowRight/ArrowLeft on the strip, wrapping at the ends', async () => {
    const el = await mountTabs([
      { label: 'First', content: 'One' },
      { label: 'Second', content: 'Two' },
      { label: 'Third', content: 'Three' }
    ])
    const strip = el.shadowRoot.querySelector('.strip')

    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await el.updateComplete
    expect(el.active).toBe(1)

    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await el.updateComplete
    // -> Wraps from 0 back to the last tab
    expect(el.active).toBe(2)
  })

  it('opens the panel holding a heading on a block-reveal event, e.g. before scrolling to it', async () => {
    const el = await mountTabs([
      { label: 'First', content: 'One' },
      { label: 'Second', content: 'Two' }
    ])
    const target = el.querySelectorAll('block-tab')[1].querySelector('p')

    // -> Dispatched ON the node inside the second panel: CustomEvent sets `event.target` to it, and
    //    the handler resolves which panel contains that node.
    target.dispatchEvent(new CustomEvent('block-reveal', { bubbles: true }))
    await el.updateComplete

    expect(el.active).toBe(1)
  })

  describe('dark mode', () => {
    it('follows body--dark via the shared DarkMode controller', async () => {
      document.body.classList.add('body--dark')
      const el = await mountTabs([{ label: 'First', content: 'One' }])

      expect(el.hasAttribute('dark')).toBe(true)

      document.body.classList.remove('body--dark')
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      expect(el.hasAttribute('dark')).toBe(false)
    })
  })
})
