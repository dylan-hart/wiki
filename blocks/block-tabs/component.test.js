import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import '../block-tab/component.js'
import { BlockTabsElement } from './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

const mountTabs = (panels, props = {}) =>
  mountBlock('block-tabs', {
    props,
    html: panels
      .map(
        ({ label, content, icon }) =>
          `<block-tab label="${label}"${icon ? ` icon="${icon}"` : ''}><p>${content}</p></block-tab>`
      )
      .join('')
  })

function stripButtons(el) {
  return [...el.shadowRoot.querySelectorAll('.tab')]
}

describe('block-tabs', () => {
  afterEach(resetBlockDom)

  it('declares `active` as a number prop with a default of 0, so sanitize-html allows the attribute', () => {
    const activeProp = BlockTabsElement.definition.props.find((prop) => prop.name === 'active')
    expect(activeProp).toMatchObject({ type: 'number', default: 0 })
  })

  it('opens the panel named by an `active` attribute set in markup', async () => {
    const el = await mountTabs([
      { label: 'First', content: 'One' },
      { label: 'Second', content: 'Two' }
    ])
    el.setAttribute('active', '1')
    await el.updateComplete

    const panels = [...el.querySelectorAll('block-tab')]
    expect(panels[0].style.display).toBe('none')
    expect(panels[1].style.display).toBe('block')
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
    expect(el.active).toBe(2)
  })

  it('opens the panel holding a heading on a block-reveal event, e.g. before scrolling to it', async () => {
    const el = await mountTabs([
      { label: 'First', content: 'One' },
      { label: 'Second', content: 'Two' }
    ])
    const target = el.querySelectorAll('block-tab')[1].querySelector('p')

    // -> Dispatched ON the node inside the panel: the handler resolves the panel from `event.target`
    target.dispatchEvent(new CustomEvent('block-reveal', { bubbles: true }))
    await el.updateComplete

    expect(el.active).toBe(1)
  })

  it('fetches every tab icon concurrently and triggers a single update', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => '<svg>icon</svg>' })
    vi.stubGlobal('fetch', fetchSpy)

    // -> Built by hand rather than through `mountTabs`, so the spy and the handle on `_loadIcons`'
    //    own promise are in place *before* `connectedCallback` fires its fire-and-forget call to it
    const el = document.createElement('block-tabs')
    for (const [index, icon] of [
      'mdi:tabs-first-1768',
      'mdi:tabs-second-1768',
      'mdi:tabs-third-1768'
    ].entries()) {
      const tab = document.createElement('block-tab')
      tab.setAttribute('label', `Tab ${index + 1}`)
      tab.setAttribute('icon', icon)
      tab.innerHTML = `<p>Content ${index + 1}</p>`
      el.appendChild(tab)
    }
    const originalLoadIcons = el._loadIcons.bind(el)
    let loadIconsPromise
    el._loadIcons = () => (loadIconsPromise = originalLoadIcons())
    const updateSpy = vi.spyOn(el, 'requestUpdate')

    document.body.appendChild(el)
    await el.updateComplete
    // -> The first render comes from `_collectTabs` setting `_tabs`, not from `_loadIcons`; clear it
    //    so only `_loadIcons`' own `requestUpdate()` calls are counted
    updateSpy.mockClear()
    await loadIconsPromise

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(el._tabs.map((t) => t.svg)).toEqual([
      '<svg>icon</svg>',
      '<svg>icon</svg>',
      '<svg>icon</svg>'
    ])
    expect(updateSpy).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })

  describeDarkMode(() => mountTabs([{ label: 'First', content: 'One' }]))

  describe('print', () => {
    const cssText = BlockTabsElement.styles.cssText
    const printStart = cssText.indexOf('@media print')
    const printBlock = printStart === -1 ? '' : cssText.slice(printStart)

    it('stamps each panel with the label a printed page draws above it, falling back to "Tab N"', async () => {
      const el = await mountTabs([
        { label: 'First', content: 'One' },
        { label: '', content: 'Two' }
      ])
      const panels = [...el.querySelectorAll('block-tab')]
      expect(panels.map((p) => p.getAttribute('data-print-label'))).toEqual(['First', 'Tab 2'])
    })

    it('has an @media print section', () => {
      expect(printStart).toBeGreaterThan(-1)
    })

    it('shows every panel with !important, which is what beats the inline display: none', () => {
      expect(printBlock).toMatch(/::slotted\(block-tab\)\s*\{[^}]*display:\s*block\s*!important/)
    })

    it('draws each panel’s label from data-print-label and hides the strip', () => {
      expect(printBlock).toMatch(/::slotted\(block-tab\)::before\s*\{[^}]*attr\(data-print-label\)/)
      expect(printBlock).toMatch(/\.strip,\s*\.tabs-marks\s*\{\s*display:\s*none/)
    })

    it('resets the theme tokens the printed frame still reads to paper-safe values', () => {
      expect(printBlock).toMatch(/:host\s*\{[^}]*--tabs-panel-bg:\s*#fff/)
      expect(printBlock).toMatch(/:host\s*\{[^}]*--tabs-border:\s*#999/)
    })
  })

  /**
   * Asserted against the source text rather than the mounted shadow root: jsdom runs no
   * layout/paint, so `getComputedStyle` cannot confirm a `var(--tabs-*)` resolving to a real value
   * either way.
   */
  describe('Ledger/Cobalt custom-property theming (OpenProject #2874)', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'component.js'), 'utf8')

    it('draws the corner marks as an aria-hidden sibling of .tabs, keyed off --tabs-corner-marks', async () => {
      const el = await mountTabs([{ label: 'First', content: 'One' }])
      const marks = el.shadowRoot.querySelector('.tabs-wrap > .tabs-marks')

      expect(marks).not.toBeNull()
      expect(marks.getAttribute('aria-hidden')).toBe('true')
      expect(marks.nextElementSibling.classList.contains('tabs')).toBe(true)
    })

    it('reads every --tabs-* property the tabset-block.md table declares, and none of the old hardcoded defaults', () => {
      for (const token of [
        '--tabs-border',
        '--tabs-radius',
        '--tabs-shadow',
        '--tabs-corner-marks',
        '--tabs-strip-bg',
        '--tabs-strip-padding',
        '--tabs-strip-gap',
        '--tabs-strip-rule',
        '--tabs-tab-padding',
        '--tabs-tab-radius',
        '--tabs-tab-rule',
        '--tabs-inactive-fg',
        '--tabs-inactive-icon',
        '--tabs-hover-bg',
        '--tabs-hover-fg',
        '--tabs-active-fg',
        '--tabs-active-weight',
        '--tabs-active-cap',
        '--tabs-focus-ring',
        '--tabs-panel-bg',
        '--tabs-panel-padding'
      ]) {
        expect(source).toContain(`var(${token})`)
      }
      // -> The marks' colour is shared across blocks, so it is in the --block-* namespace
      expect(source).toContain('var(--block-mark-color)')

      // -> No hardcoded fallbacks: a Quasar-blue active tab, literal gradients, the transparent
      //    border-top the cap shadow replaces, or a `:host([dark])` block of local overrides
      expect(source).not.toContain('--q-primary')
      expect(source).not.toContain('linear-gradient(to bottom')
      expect(source).not.toMatch(/border-top:\s*3px solid transparent/)
      expect(source).not.toContain(':host([dark])')
    })

    it('declares no local --tabs-* fallback values of its own any more', () => {
      // -> The whole property set is inherited from <body>, declared in tailwind.css
      const screenSource = source.replace(/@media print[\s\S]*?\n {6}\}\n/, '')
      const hostBlocks = [...screenSource.matchAll(/:host\s*{([^}]*)}/g)].map((m) => m[1])
      expect(hostBlocks.length).toBeGreaterThan(0)
      for (const block of hostBlocks) {
        expect(block).not.toMatch(/--tabs-/)
      }
    })
  })
})
