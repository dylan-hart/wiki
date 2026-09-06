import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import TableEditorOverlay from './TableEditorOverlay.vue'
import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'
import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * The other half of OpenProject #1929's change here: deleting the `docsBase`-based help button left
 * `siteStore` still in use elsewhere in this component, so removing the button must not have taken
 * the store with it. The "no docsBase button" assertion itself lives in `src/docsBaseGate.test.js`
 * alongside the six other fork-invented surfaces it applies to.
 */
const source = readFileSync(join(import.meta.dirname, 'TableEditorOverlay.vue'), 'utf-8')

describe('TableEditorOverlay help link', () => {
  it('still uses siteStore elsewhere in the component', () => {
    expect(source).toContain('siteStore.overlayOpts')
  })
})

/**
 * OpenProject #2530: `editing` (and therefore the starting grid) now reads off the `overlayOpts` prop
 * `MainOverlayDialog.vue` forwards, not `siteStore.overlayOpts` directly.
 */
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
 * OpenProject #2628 -- the first full comparison of this screen against
 * `ui-redesign/Cardinal Wiki - Table Editor 3x.dc.html`.
 *
 * These are the claims a DOM emulator can actually answer: which glyph is drawn, which element
 * carries which role, what a prop resolved to. The metrics the design states in pixels -- the 28px
 * toolbar band, the 24x22 tool plates, the 200px cell -- are measured in a real browser in the
 * describe below, because neither `happy-dom` nor `jsdom` runs a layout engine.
 */
describe('TableEditorOverlay design conformance (OpenProject #2628)', () => {
  function mountOverlay() {
    return mountWithApp(TableEditorOverlay).wrapper
  }

  it("heads the overlay with the design's stroked table glyph, not a colour asset", () => {
    const wrapper = mountOverlay()

    expect(wrapper.find('.card-header .w-icon').attributes('data-icon')).toBe('tabler:table')
    // -> The regression this replaces: an `img:/_assets/icons/color-*.svg` reference, which `WIcon`
    //    draws as an <img> and which was the last colour icon left in any overlay header
    expect(source).not.toMatch(/name="img:/)
  })

  /*
    `dense` IS the design's 28px band on a 10px inset -- `WBtn` writes both inline off its own
    12.5px font size (2.24em / 0.8em), so the resolved inline style is what the prop actually did.
    Asserted here rather than by looking for the word `dense` in the template, which would pass just
    as happily if `WBtn`'s dense metrics ever stopped being the design's.
  */
  it('draws every toolbar control on the 28px band the design draws them at', () => {
    const wrapper = mountOverlay()
    const buttons = wrapper.findAll('.table-editor-toolbar .w-btn')

    expect(buttons.length).toBe(3)
    for (const button of buttons) {
      expect(button.attributes('style')).toContain('min-height: 2.24em')
      expect(button.attributes('style')).toContain('padding: 0px 0.8em')
    }
  })

  /*
    The design strokes the alignment glyph `#64789f` (the icon slate) and the delete `#c14a52` (the
    accent, which is what `negative` resolves to). The alignment used to be drawn in the accent too,
    which left two reds in a row where the design has one.
  */
  it('strokes the column alignment tool in the icon slate and the delete in the accent', () => {
    const wrapper = mountOverlay()
    const [align, remove] = wrapper.findAll('.table-editor-tools .w-btn')

    expect(align.classes()).toContain('text-slate-soft')
    expect(align.attributes('style') ?? '').not.toContain('--color-primary')
    expect(remove.attributes('style')).toContain('var(--color-negative)')
  })

  /*
    Only the cells holding an input are plates. The tools row above the head and the row-tools column
    down the side are chrome and stay unstyled -- which is what lets the plate rule be a plain class
    rather than a `th, td` rule undone twice with `!important`.
  */
  it('marks the data cells as plates and leaves the two chrome columns alone', () => {
    const wrapper = mountOverlay()

    // -> 3 header cells + 2 body rows x 3 = 9
    expect(wrapper.findAll('.table-editor-cellbox').length).toBe(9)
    expect(wrapper.findAll('.table-editor-cellbox .table-editor-cell').length).toBe(9)
    expect(wrapper.findAll('.table-editor-rowtools.table-editor-cellbox').length).toBe(0)
    expect(wrapper.findAll('.table-editor-tools .table-editor-cellbox').length).toBe(0)
  })

  /*
    A headerless table has no head row at all, so its plates are the body's alone -- the tick has to
    keep the grid's own structure in step, not just the markdown under it.
  */
  it("drops the header row's plates entirely when the table is headerless", async () => {
    const wrapper = mountOverlay()
    wrapper.vm.state.headerless = true
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('thead .table-editor-cellbox').length).toBe(0)
    expect(wrapper.findAll('tbody .table-editor-cellbox').length).toBe(9)
  })

  /*
    Two things this screen must NOT do, per the epic's coordination note: retune `.w-section-header`
    (OpenProject #2631 owns the band's own rhythm across all eleven of its callers) and write a
    radius (the `--radius-*` scale is zeroed, and `--radius-full` survives only for genuinely round
    shapes -- a cell corner is neither).
  */
  it('leaves the section-header band and the zeroed radius scale alone', () => {
    expect(source).toContain('class="w-section-header')
    expect(source).not.toMatch(/\.w-section-header\s*\{/)
    expect(source).not.toMatch(/border-radius|rounded-(?!none)/)
  })
})

/*
  The design's pixel claims, measured in a real headless Chromium: `happy-dom` reports every element
  at a zeroed rect regardless of its CSS, so none of this is answerable under the default
  environment. `{ skip: !hasChromium() }` and the raised timeout follow `ApiKeyCreateDialog.test.js`,
  for the same reasons its own comment gives -- `npm ci` installs the Playwright library, not the
  browser, and a cold launch is not a 5-second operation beside seven other worker processes.

  The stylesheet handed to the page is the app's real compiled Tailwind (`buildAppCss()`) PLUS every
  `<style>` Vitest injected into this process's document -- which, with `css: true`, is where this
  SFC's own compiled SCSS lands. Both halves are needed: the toolbar's ground is a Tailwind utility
  chain and the tool plate is an SFC rule that has to beat `WBtn`'s inline metrics, and measuring
  either without the other would prove nothing.
*/
describe(
  'TableEditorOverlay design conformance — real layout (OpenProject #2628)',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let metrics
    let dark

    /*
      Measured under BOTH body classes off the same markup. Dark mode here is not a filter over the
      light rules -- the toolbar, the cell plate and the banding each name their own rung of the dark
      ramp -- and it is the half nobody looks at while working, so a rule that never matches would
      otherwise ship silently.
    */
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
          return {
            addRow: box('.table-editor-toolbar .w-btn'),
            toolButtons,
            cell: box('.table-editor-cell'),
            separator: box('.table-editor-toolbar .w-separator'),
            toolbarBg: bg('.table-editor-toolbar'),
            toolbarBorder: getComputedStyle(toolbar).borderBottomWidth,
            toolbarBorderColor: getComputedStyle(toolbar).borderBottomColor,
            cellBorderColor: getComputedStyle(document.querySelector('.table-editor-cellbox'))
              .borderTopColor,
            bodyRows
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
    })

    afterAll(async () => {
      await browser?.close()
    })

    it("draws the toolbar controls on the design's 28px band", () => {
      expect(metrics.addRow.height).toBe(28)
    })

    /*
      The claim this exists for: `WBtn` writes `min-height` and `padding` INLINE, so the 24x22 plate
      is a cascade question, not a declaration one -- get the specificity wrong and the plate is
      silently the 32px button band instead, with nothing in the markup to say so.
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
      The same three surfaces on the dark ramp: `$dark-2` raised for the toolbar, `$dark-3` panel for
      a cell plate, `$dark-4` recessed for the band -- the same two-step apart the light half draws,
      one rung lower. There is no dark sheet for this screen, so these are the ramp's own answers
      rather than measured design values, and they are pinned here so they stay deliberate.
    */
    it('carries the same three surfaces onto the dark ramp', () => {
      expect(dark.toolbarBg).toBe('rgb(36, 43, 58)')
      expect(dark.toolbarBorderColor).toBe('rgb(42, 48, 64)')
      expect(dark.cellBorderColor).toBe('rgb(42, 48, 64)')
      expect(dark.bodyRows).toEqual(['rgb(27, 31, 42)', 'rgb(23, 27, 36)'])
    })

    /* -> The plate is a cascade fight with `WBtn`'s inline metrics, and the cascade is theme-blind --
          but a `dark:` utility landing on the same element is not, so it is measured either way */
    it('keeps the tool plates at 24x22 in dark mode too', () => {
      expect(dark.toolButtons).toEqual(metrics.toolButtons)
    })
  }
)
