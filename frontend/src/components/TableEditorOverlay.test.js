import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import TableEditorOverlay from './TableEditorOverlay.vue'
import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'
import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * `src/docsBaseGate.test.js` owns the "no docsBase help button" assertion for this component; what
 * is left to guard here is that dropping that button did not take `siteStore` with it.
 */
const source = readFileSync(join(import.meta.dirname, 'TableEditorOverlay.vue'), 'utf-8')
const baseCss = readFileSync(join(import.meta.dirname, '..', 'css', '_base.css'), 'utf-8')

describe('TableEditorOverlay help link', () => {
  it('still uses siteStore elsewhere in the component', () => {
    expect(source).toContain('siteStore.overlayOpts')
  })
})

describe('TableEditorOverlay editing state (OpenProject #2530)', () => {
  function mountOverlay(overlayOpts) {
    setActivePinia(createPinia())
    const i18n = createTestI18n({})
    return mount(TableEditorOverlay, {
      props: overlayOpts ? { overlayOpts } : {},
      global: { plugins: [i18n] }
    })
  }

  it('starts with the default blank 3x3 grid when no overlayOpts prop is given', () => {
    const wrapper = mountOverlay()

    expect(wrapper.vm.state.rows).toEqual([
      ['Column 1', 'Column 2', 'Column 3'],
      ['', '', ''],
      ['', '', '']
    ])
    expect(wrapper.vm.state.replace).toBeNull()
  })

  it('parses overlayOpts.source into the starting grid, and carries replace.startLine/endLine', () => {
    const wrapper = mountOverlay({
      source: '| A | B |\n| --- | --- |\n| x | y |',
      startLine: 4,
      endLine: 6
    })

    expect(wrapper.vm.state.rows).toEqual([
      ['A', 'B'],
      ['x', 'y']
    ])
    expect(wrapper.vm.state.replace).toEqual({ startLine: 4, endLine: 6 })
  })
})

/**
 * The claims a DOM emulator can answer: which glyph is drawn, which element carries which role,
 * what a prop resolved to. The metrics the design states in pixels are measured in a real browser
 * in the describe below, because neither `happy-dom` nor `jsdom` runs a layout engine.
 */
describe('TableEditorOverlay design conformance (OpenProject #2628)', () => {
  function mountOverlay() {
    return mountWithApp(TableEditorOverlay).wrapper
  }

  it("heads the overlay with the design's stroked table glyph, not a colour asset", () => {
    const wrapper = mountOverlay()

    expect(wrapper.find('.card-header .w-icon').attributes('data-icon')).toBe('tabler:table')
    // -> `WIcon` draws an `img:` reference as an <img>, which is the colour-asset form no overlay
    //    header may fall back to
    expect(source).not.toMatch(/name="img:/)
  })

  /*
    Asserted off `WBtn`'s resolved inline style rather than the word `dense` in the template, which
    would pass just as happily if `WBtn`'s dense metrics stopped being the design's band.
  */
  it("keeps every toolbar control on WBtn's dense 10px inset the design draws them at", () => {
    const wrapper = mountOverlay()
    const buttons = wrapper.findAll('.table-editor-toolbar .w-btn')

    expect(buttons.length).toBe(3)
    for (const button of buttons) {
      expect(button.attributes('style')).toContain('min-height: 2.24em')
      expect(button.attributes('style')).toContain('padding: 0px 0.8em')
    }
  })

  /*
    Padding or a gap on the band would sit between a button's hover cell and the band's edge, or
    between two neighbours' cells.
  */
  it('puts the shared flush-hover-btn on every toolbar button, flat and not round', () => {
    const wrapper = mountOverlay()
    const buttons = wrapper.findAll('.table-editor-toolbar .w-btn')

    expect(buttons.length).toBe(3)
    for (const button of buttons) {
      expect(button.classes()).toContain('flush-hover-btn')
      expect(button.classes()).toContain('w-btn--flat')
      expect(button.classes()).not.toContain('w-btn--round')
      // -> Labelled buttons: the icon-only `--square` would stretch them, `--cap` would round them
      expect(button.classes()).not.toContain('flush-hover-btn--square')
      expect(button.classes()).not.toContain('flush-hover-btn--cap')
    }
  })

  it('takes no padding or gap on the band itself, and stretches the buttons to its height', () => {
    const toolbar = mountOverlay().find('.table-editor-toolbar')

    expect(toolbar.classes()).toContain('items-stretch')
    expect(toolbar.classes()).not.toContain('items-center')
    for (const utility of ['px-4', 'py-2', 'gap-2', 'gap-1', 'gap-4']) {
      expect(toolbar.classes()).not.toContain(utility)
    }
  })

  it('leaves the Cancel/Update pair off the flush primitive, so it keeps its Cobalt gap', () => {
    const wrapper = mountOverlay()

    for (const button of wrapper.findAll('.card-header .w-btn-group .w-btn')) {
      expect(button.classes()).not.toContain('flush-hover-btn')
    }
  })

  it('adds no flush-hover rule of its own -- the primitive lives in _base.css', () => {
    expect(source).not.toMatch(/\.flush-hover-btn/)
  })

  /*
    The design strokes the alignment glyph `#64789f` (the icon slate) and the delete `#c14a52` (the
    accent, which is what `negative` resolves to) -- drawing both in the accent leaves two reds in a
    row where the design has one.
  */
  it('strokes the column alignment tool in the icon slate and the delete in the accent', () => {
    const wrapper = mountOverlay()
    const [align, remove] = wrapper.findAll('.table-editor-tools .w-btn')

    expect(align.classes()).toContain('text-slate-soft')
    expect(align.attributes('style') ?? '').not.toContain('--color-primary')
    expect(remove.attributes('style')).toContain('var(--color-negative)')
  })

  /*
    Only the cells holding an input are plates; the tools row and the row-tools column are chrome
    and stay unstyled. That is what lets the plate rule be a plain class rather than a `th, td`
    rule undone twice with `!important`.
  */
  it('marks the data cells as plates and leaves the two chrome columns alone', () => {
    const wrapper = mountOverlay()

    expect(wrapper.findAll('.table-editor-cellbox').length).toBe(9)
    expect(wrapper.findAll('.table-editor-cellbox .table-editor-cell').length).toBe(9)
    expect(wrapper.findAll('.table-editor-rowtools.table-editor-cellbox').length).toBe(0)
    expect(wrapper.findAll('.table-editor-tools .table-editor-cellbox').length).toBe(0)
  })

  /*
    The headerless tick has to keep the grid's own structure in step, not just the markdown under it.
  */
  it("drops the header row's plates entirely when the table is headerless", async () => {
    const wrapper = mountOverlay()
    wrapper.vm.state.headerless = true
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('thead .table-editor-cellbox').length).toBe(0)
    expect(wrapper.findAll('tbody .table-editor-cellbox').length).toBe(9)
  })

  /*
    `.w-section-header`'s rhythm is shared across every screen that uses the band, so this one must
    not retune it.
  */
  it('leaves the section-header band alone', () => {
    expect(source).toContain('class="w-section-header')
    expect(source).not.toMatch(/\.w-section-header\s*\{/)
  })

  // -> The Cobalt rules are a contiguous run of flat top-level rules rather than one nested block,
  //    so the region is taken as a text range instead of by brace balancing.
  const cobaltRegionStart = source.indexOf('body.body--cobalt .table-editor-grid table {')
  const cobaltRegionEndMarker =
    'body.body--cobalt.body--dark .table-editor th.table-editor-cellbox {'
  const cobaltRegionEnd =
    source.indexOf('}', source.indexOf(cobaltRegionEndMarker, cobaltRegionStart)) + 1
  const cobaltBlock = source.slice(cobaltRegionStart, cobaltRegionEnd)

  /*
    The `--radius-*` scale is zeroed outside Cobalt, so the grid's one radius must stay scoped to
    `.body--cobalt` rather than leaking out under any other aesthetic.
  */
  it('scopes the single-plate radius to Cobalt alone, leaving every other aesthetic square', () => {
    expect(cobaltRegionStart).toBeGreaterThan(-1)
    expect(cobaltBlock).toContain('border-radius')

    const withoutCobaltBlock = source.replace(cobaltBlock, '')
    expect(withoutCobaltBlock).not.toMatch(/border-radius|rounded-(?!none)/)
  })

  it("collapses the per-cell border into the plate's own border-spacing gap under Cobalt", () => {
    expect(cobaltBlock).toContain('border-collapse: separate')
    expect(cobaltBlock).toContain('border-spacing: 2px')
    expect(cobaltBlock).toMatch(/body\.body--cobalt \.table-editor-cellbox\s*\{\s*border: 0;/)
  })

  it('tints Cobalt header cells distinctly from the plate and the data cells', () => {
    expect(cobaltBlock).toMatch(
      /body\.body--cobalt \.table-editor th\.table-editor-cellbox\s*\{\s*background-color: #eef2ff;/
    )
  })

  it('rings the focused Cobalt cell instead of tinting it', () => {
    expect(cobaltBlock).toMatch(/body\.body--cobalt \.table-editor-cell:focus\s*\{/)
    expect(cobaltBlock).toContain('box-shadow: inset 0 0 0 2px var(--color-accent-strong)')
  })
})

/*
 * `gap` is a plain CSS value `happy-dom` resolves with no layout engine needed. The Ledger seam it
 * replaces is a logical `border-inline-end`, which `happy-dom` does not resolve for
 * `getComputedStyle` at all -- even a bare rule with no cascade involved reads back empty -- so the
 * seam's own presence is asserted only in the real-layout describe below.
 */
describe('TableEditorOverlay Cancel/Update button gap (OpenProject #2871)', () => {
  let wrapper

  // -> `attachTo: document.body` leaves the mounted tree attached, so the previous test's own
  //    `.w-btn-group` has to be torn down first or `document.body.querySelector` can silently
  //    resolve the stale one
  afterEach(() => {
    wrapper?.unmount()
    document.body.classList.remove('body--cobalt', 'body--light', 'body--dark')
  })

  it('takes no gap outside Cobalt', () => {
    document.body.classList.add('body--light')
    wrapper = mountWithApp(TableEditorOverlay, { attachTo: document.body }).wrapper

    const group = document.body.querySelector('.card-header .w-btn-group')
    expect(getComputedStyle(group).gap).not.toBe('8px')
  })

  it.each(['body--light', 'body--dark'])('takes the 8px gap under Cobalt (%s)', (theme) => {
    document.body.classList.add('body--cobalt', theme)
    wrapper = mountWithApp(TableEditorOverlay, { attachTo: document.body }).wrapper

    const group = document.body.querySelector('.card-header .w-btn-group')
    expect(getComputedStyle(group).gap).toBe('8px')
  })
})

/*
  `happy-dom` reports every element at a zeroed rect regardless of its CSS, so the design's pixel
  claims are measured in a real headless Chromium. `{ skip: !hasChromium() }` and the raised timeout
  are there because `npm ci` installs the Playwright library but not the browser, and a cold launch
  is not a 5-second operation beside seven other worker processes.

  The page is handed the app's real compiled Tailwind PLUS every `<style>` Vitest injected for this
  SFC. Both halves are needed: the toolbar's ground is a utility chain and the tool plate an SFC
  rule that has to beat `WBtn`'s inline metrics, so either alone would prove nothing.
*/
describe(
  'TableEditorOverlay design conformance — real layout (OpenProject #2628)',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let metrics
    let dark
    let cobalt
    let cobaltDark

    /*
      Dark mode is not a filter over the light rules -- each surface names its own rung of the dark
      ramp -- and it is the half nobody looks at while working, so a rule that never matches would
      otherwise ship silently.
    */
    async function measure(bodyClass) {
      const wrapper = mountWithApp(TableEditorOverlay).wrapper
      const html = wrapper.html()
      const sfcCss = [...document.querySelectorAll('style')]
        .map((style) => style.textContent)
        .join('\n')
      // -> Measured 1600px wide: the test i18n renders raw message keys, long enough to wrap the
      //    toolbar's hint onto a second line at 1100px and double the band's height
      // -> `buildAppCss()` compiles `tailwind.css` alone; `_base.css` is one of `app.css`'s own
      //    `@import`s, so it is appended by hand, as the app loads it
      const appCss = `${await buildAppCss()}\n${baseCss}`

      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${sfcCss}</style></head>` +
            `<body class="${bodyClass}" style="margin:0">` +
            `<div style="width:1600px;height:800px">${html}</div></body></html>`
        )
        return await page.evaluate(() => {
          const box = (selector) => {
            const el = document.querySelector(selector)
            if (!el) {
              return null
            }
            const rect = el.getBoundingClientRect()
            return { width: Math.round(rect.width), height: Math.round(rect.height) }
          }
          const bg = (selector) =>
            getComputedStyle(document.querySelector(selector)).backgroundColor
          const toolButtons = [...document.querySelectorAll('.table-editor-toolbtn')].map((el) => {
            const rect = el.getBoundingClientRect()
            return { width: Math.round(rect.width), height: Math.round(rect.height) }
          })
          const bodyRows = [...document.querySelectorAll('tbody tr')].map(
            (row) => getComputedStyle(row.querySelector('.table-editor-cellbox')).backgroundColor
          )
          const toolbar = document.querySelector('.table-editor-toolbar')
          const toolbarRect = toolbar.getBoundingClientRect()
          const toolbarButtons = [...toolbar.querySelectorAll(':scope > .w-btn')].map((el) => {
            const rect = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            return {
              left: Math.round(rect.left - toolbarRect.left),
              top: Math.round(rect.top - toolbarRect.top),
              right: Math.round(rect.right - toolbarRect.left),
              height: Math.round(rect.height),
              radius: style.borderTopLeftRadius
            }
          })
          const table = document.querySelector('.table-editor-grid table')
          const headerCell = document.querySelector('thead tr:last-child th.table-editor-cellbox')
          const cellInput = document.querySelector('.table-editor-cell')
          cellInput.focus()
          const focusedCellStyle = getComputedStyle(cellInput)
          return {
            addRow: box('.table-editor-toolbar .w-btn'),
            toolbarHeight: Math.round(toolbarRect.height),
            toolbarBorderBottom: parseFloat(getComputedStyle(toolbar).borderBottomWidth),
            toolbarButtons,
            toolButtons,
            cell: box('.table-editor-cell'),
            separator: box('.table-editor-toolbar .w-separator'),
            toolbarBg: bg('.table-editor-toolbar'),
            toolbarBorder: getComputedStyle(toolbar).borderBottomWidth,
            toolbarBorderColor: getComputedStyle(toolbar).borderBottomColor,
            cellBorderColor: getComputedStyle(document.querySelector('.table-editor-cellbox'))
              .borderTopColor,
            cellBorderWidth: getComputedStyle(document.querySelector('.table-editor-cellbox'))
              .borderTopWidth,
            bodyRows,
            plateBg: getComputedStyle(table).backgroundColor,
            plateRadius: getComputedStyle(table).borderTopLeftRadius,
            plateBorderSpacing: getComputedStyle(table).borderSpacing,
            headerCellBg: getComputedStyle(headerCell).backgroundColor,
            toolsRowBg: bg('.table-editor-tools th'),
            rowToolsBg: bg('.table-editor-rowtools'),
            focusedCellBoxShadow: focusedCellStyle.boxShadow,
            focusedCellBg: focusedCellStyle.backgroundColor
          }
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
      metrics = await measure('body--light')
      dark = await measure('body--dark')
      cobalt = await measure('body--cobalt body--light')
      cobaltDark = await measure('body--cobalt body--dark')
    })

    afterAll(async () => {
      await browser?.close()
    })

    it("keeps the toolbar band at the design's 44px, its controls filling it", () => {
      expect(metrics.toolbarHeight).toBe(44)
      // -> the band's 1px bottom rule is inside its border box, so the buttons fill what is above it
      expect(metrics.addRow.height).toBe(44 - metrics.toolbarBorderBottom)
    })

    /*
      Measured in every aesthetic and both modes: Cobalt's `.w-btn` radius and group gap are the two
      things that could put a rounded corner or a dead strip back.
    */
    for (const [label, pick] of [
      ['Ledger light', () => metrics],
      ['Ledger dark', () => dark],
      ['Cobalt light', () => cobalt],
      ['Cobalt dark', () => cobaltDark]
    ]) {
      it(`draws the toolbar buttons as square cells flush to the band and each other (${label})`, () => {
        const { toolbarButtons, toolbarHeight, toolbarBorderBottom } = pick()

        expect(toolbarButtons.length).toBe(3)
        expect(toolbarButtons[0].left).toBe(0)
        for (const button of toolbarButtons) {
          expect(button.top).toBe(0)
          expect(button.height).toBe(toolbarHeight - toolbarBorderBottom)
          expect(button.radius).toBe('0px')
        }
        // -> Add row and Add column abut: no gap between their hover cells
        expect(toolbarButtons[1].left).toBe(toolbarButtons[0].right)
      })
    }

    /*
      `WBtn` writes `min-height` and `padding` INLINE, so the plate's size is a cascade question,
      not a declaration one -- get the specificity wrong and it is silently the 32px button band
      instead, with nothing in the markup to say so.
    */
    it("sizes every column and row tool as the design's 24x22 plate", () => {
      expect(metrics.toolButtons.length).toBe(8)
      for (const plate of metrics.toolButtons) {
        expect(plate).toEqual({ width: 24, height: 22 })
      }
    })

    it("sets each cell to the design's 200px width", () => {
      expect(metrics.cell.width).toBe(200)
    })

    it("draws the divider as the design's 22px tick, not a full-height rule", () => {
      expect(metrics.separator.height).toBe(22)
    })

    it('grounds the toolbar in the page tint, ruled off underneath', () => {
      // -> `--color-tint` #eef1f7 and `--color-hairline` #dbe1ec
      expect(metrics.toolbarBg).toBe('rgb(238, 241, 247)')
      expect(metrics.toolbarBorder).toBe('1px')
      expect(metrics.toolbarBorderColor).toBe('rgb(219, 225, 236)')
    })

    it("edges every cell in the language's one border colour", () => {
      expect(metrics.cellBorderColor).toBe('rgb(219, 225, 236)')
    })

    it('bands the second body row, as the design draws it', () => {
      expect(metrics.bodyRows).toEqual(['rgb(255, 255, 255)', 'rgb(248, 249, 252)'])
    })

    /*
      The same three surfaces one rung lower: raised for the toolbar, panel for a cell plate,
      recessed for the band. There is no dark sheet for this screen, so these are the ramp's own
      answers rather than measured design values, pinned here so they stay deliberate.
    */
    it('carries the same three surfaces onto the dark ramp', () => {
      expect(dark.toolbarBg).toBe('rgb(36, 43, 58)')
      expect(dark.toolbarBorderColor).toBe('rgb(42, 48, 64)')
      expect(dark.cellBorderColor).toBe('rgb(42, 48, 64)')
      expect(dark.bodyRows).toEqual(['rgb(27, 31, 42)', 'rgb(23, 27, 36)'])
    })

    /* -> The cascade the plate wins is theme-blind, but a `dark:` utility landing on the same
          element is not, so it is measured either way */
    it('keeps the tool plates at 24x22 in dark mode too', () => {
      expect(dark.toolButtons).toEqual(metrics.toolButtons)
    })

    it('grounds the grid in one tinted, radiused plate rather than a collapsed table', () => {
      // -> `--color-tint` #e6edff light, `--radius-card` 8px
      expect(cobalt.plateBg).toBe('rgb(230, 237, 255)')
      expect(cobalt.plateRadius).toBe('8px')
      expect(Number.parseFloat(cobalt.plateBorderSpacing)).toBe(2)
    })

    it('removes the per-cell border under Cobalt, leaving separation to the plate gap', () => {
      expect(cobalt.cellBorderWidth).toBe('0px')
      expect(cobaltDark.cellBorderWidth).toBe('0px')
    })

    it('tints the Cobalt header row distinctly from the plate and the white data cells', () => {
      // -> `#eef2ff` light; `--color-dark-3` `#141c4f` dark -- no design board for Cobalt dark, so
      //    that is the ramp's own "one rung more raised than the plate" answer
      expect(cobalt.headerCellBg).toBe('rgb(238, 242, 255)')
      expect(cobaltDark.headerCellBg).toBe('rgb(20, 28, 79)')
    })

    it('grounds the Cobalt chrome strips in the page tint, matching the board', () => {
      // -> `--color-paper` #f2f5ff light, #0a0f2c dark
      expect(cobalt.toolsRowBg).toBe('rgb(242, 245, 255)')
      expect(cobalt.rowToolsBg).toBe('rgb(242, 245, 255)')
      expect(cobaltDark.toolsRowBg).toBe('rgb(10, 15, 44)')
      expect(cobaltDark.rowToolsBg).toBe('rgb(10, 15, 44)')
    })

    it('rings the focused Cobalt cell in the accent instead of tinting its ground', () => {
      // -> `--color-accent-strong` #1f4fd6 light, #7fa0ff dark; `--color-surface` #fff unchanged
      expect(cobalt.focusedCellBg).toBe('rgb(255, 255, 255)')
      expect(cobalt.focusedCellBoxShadow).toContain('rgb(31, 79, 214)')
      expect(cobalt.focusedCellBoxShadow).toContain('inset')
      expect(cobaltDark.focusedCellBg).toBe('rgb(255, 255, 255)')
      expect(cobaltDark.focusedCellBoxShadow).toContain('rgb(127, 160, 255)')
    })
  }
)

/*
  The on-screen distance between the two buttons, as opposed to the `gap` property's literal value
  already covered under jsdom, needs a real browser: `happy-dom` reports every rect at zero
  regardless of CSS.
*/
describe(
  'TableEditorOverlay Cancel/Update button gap — real layout (OpenProject #2871)',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser

    async function measure(bodyClass) {
      const wrapper = mountWithApp(TableEditorOverlay).wrapper
      const html = wrapper.html()
      const sfcCss = [...document.querySelectorAll('style')]
        .map((style) => style.textContent)
        .join('\n')
      const appCss = await buildAppCss()

      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${sfcCss}</style></head>` +
            `<body class="${bodyClass}" style="margin:0">` +
            `<div style="width:1100px;height:800px">${html}</div></body></html>`
        )
        return await page.evaluate(() => {
          const [cancel, update] = [
            ...document.querySelectorAll('.card-header .w-btn-group .w-btn')
          ].map((el) => el.getBoundingClientRect())
          return Math.round(update.left - cancel.right)
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('draws Cancel and Update flush, joined by the Ledger seam, outside Cobalt', async () => {
      expect(await measure('body--light')).toBe(0)
    })

    it("opens the design's 8px gap between Cancel and Update under Cobalt, light and dark alike", async () => {
      expect(await measure('body--cobalt body--light')).toBe(8)
      expect(await measure('body--cobalt body--dark')).toBe(8)
    })
  }
)
