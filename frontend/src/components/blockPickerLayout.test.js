import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import BlockPickerOverlay from './BlockPickerOverlay.vue'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Claims about where the browser actually puts a box — a `minmax(max(…), 1fr)` track count, and
 * selection costing no layout — which no DOM stand-in can answer because none runs a layout engine.
 * A static reading of the stylesheet gets exactly these wrong, so they are measured instead.
 *
 * `BlockPickerOverlay.vue`'s own `<style>` block is read alongside the app's stylesheet because
 * `buildAppCss()` compiles `src/css/tailwind.css` only — the reset, the utilities and the
 * `--color-*` tokens — and this card is drawn entirely by the SFC.
 */

const selfDir = dirname(fileURLToPath(import.meta.url))
const componentPath = join(selfDir, 'BlockPickerOverlay.vue')

/** Enough blocks for three rows at two per row, so a third column would show up as a shortfall. */
const BLOCKS = ['tabs', 'kroki', 'live-data', 'callout', 'diagram'].map((block, index) => ({
  id: `block-${index}`,
  block,
  name: `Block ${index}`,
  description: 'Group content into switchable panels.',
  icon: 'tree-structure',
  isEnabled: true,
  isCustom: false,
  config: {},
  props: [],
  template: ''
}))

async function componentCss() {
  const source = await readFile(componentPath, 'utf8')
  return source.match(/<style>([\s\S]*?)<\/style>/)[1]
}

async function mountPicker() {
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(BLOCKS) })
  const { wrapper } = mountWithApp(BlockPickerOverlay)
  await flushPromises()
  return wrapper
}

/**
 * Rects are rounded to a hundredth of a pixel: two renders of identical markup agree exactly, and
 * sub-hundredth noise could only be a sub-pixel artefact, never the whole-pixel shift a border adds.
 */
async function measure({ browser, css, gridHtml, width }) {
  const page = await browser.newPage()
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="body--light" style="margin:0">` +
        `<div class="block-picker" style="width:${width}px">${gridHtml}</div>` +
        `</body></html>`
    )
    return await page.evaluate(() => {
      const round = (n) => Math.round(n * 100) / 100
      const rect = (el) => {
        const r = el.getBoundingClientRect()
        return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) }
      }
      return {
        cards: [...document.querySelectorAll('.block-picker-card')].map(rect),
        marks: [...document.querySelectorAll('.block-picker-mark')].map(rect)
      }
    })
  } finally {
    await page.close()
  }
}

function rowShape(cards) {
  const rows = new Map()
  for (const card of cards) {
    rows.set(card.y, (rows.get(card.y) ?? 0) + 1)
  }
  return { rows: rows.size, widest: Math.max(...rows.values()) }
}

/*
 * Launching a real Chromium and compiling the app's whole stylesheet are both slow next to the rest
 * of the suite, which vitest runs in parallel beside this one -- hence the raised timeouts.
 */
describe(
  'the block picker catalog, measured in a real browser',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let css
    let markupPromise = null

    beforeAll(async () => {
      browser = await chromium.launch()

      const [appCss, sfcCss] = await Promise.all([buildAppCss(), componentCss()])
      css = `${appCss}\n${sfcCss}`
    }, 120000)

    afterAll(async () => {
      await browser?.close()
    })

    /*
     * Mounted from inside a test rather than in `beforeAll`: `test/setup.js` rebuilds the
     * `API_CLIENT` stub in a `beforeEach`, so it does not exist yet while `beforeAll` runs.
     * Memoized, because the markup is identical for every measurement below.
     */
    function markup() {
      markupPromise ??= (async () => {
        const wrapper = await mountPicker()
        const grid = () => wrapper.find('.block-picker-grid').element.outerHTML
        const cards = wrapper.findAll('.block-picker-card')

        const none = grid()
        await cards[0].trigger('click')
        const first = grid()
        await cards[1].trigger('click')
        const second = grid()

        return { none, first, second }
      })()
      return markupPromise
    }

    /*
     * 580px is the narrowest width that still holds two 280px tracks plus the gap; the rest span
     * laptop to full-bleed. All must be two-up: the point of the `max()` is that widening the
     * overlay adds width to the two cards rather than a third column.
     */
    it.each([1600, 940, 640, 580])(
      'holds exactly two cards per row at %ipx of catalog track',
      async (width) => {
        const { none } = await markup()
        const { cards } = await measure({ browser, css, gridHtml: none, width })

        expect(cards).toHaveLength(BLOCKS.length)
        expect(rowShape(cards)).toEqual({ rows: 3, widest: 2 })
      },
      60000
    )

    it('drops to a single column below the 280px track floor', async () => {
      const { none } = await markup()
      const { cards } = await measure({ browser, css, gridHtml: none, width: 420 })

      expect(rowShape(cards)).toEqual({ rows: BLOCKS.length, widest: 1 })
    }, 60000)

    /**
     * The three markup states differ only in which card carries `is-selected`, so any difference in
     * the rects is the selection treatment costing layout.
     */
    it('moves nothing at all as selection travels between cards', async () => {
      const html = await markup()
      const [unpicked, first, second] = await Promise.all([
        measure({ browser, css, gridHtml: html.none, width: 940 }),
        measure({ browser, css, gridHtml: html.first, width: 940 }),
        measure({ browser, css, gridHtml: html.second, width: 940 })
      ])

      expect(first.cards).toEqual(unpicked.cards)
      expect(second.cards).toEqual(unpicked.cards)
      // -> The marks are out of flow in every state, so they sit in the same places throughout
      expect(first.marks).toEqual(unpicked.marks)
      expect(second.marks).toEqual(unpicked.marks)
      expect(unpicked.marks).toHaveLength(BLOCKS.length * 4)
    }, 60000)

    /**
     * The `-4px` each corner is offset by resolves against the card's PADDING box, the containing
     * block for an absolutely-positioned child of a `position: relative` element. The card's
     * hairline is 1px, so the mark clears the BORDER box — the edge `getBoundingClientRect` reports
     * — by 3px, and 3 is what this asserts: writing the CSS literal instead of the rendered result
     * is what a real browser is here to prevent.
     */
    it('draws each corner mark clear of its card, outside the hairline it decorates', async () => {
      const html = await markup()
      const { cards, marks } = await measure({ browser, css, gridHtml: html.first, width: 940 })

      const clearance = 4 - 1 // -> the -4px offset, less the 1px hairline the padding box sits inside
      const [card] = cards
      const [topLeft, topRight, bottomLeft, bottomRight] = marks.slice(0, 4)

      expect(topLeft.x).toBeCloseTo(card.x - clearance, 1)
      expect(topLeft.y).toBeCloseTo(card.y - clearance, 1)
      expect(topRight.x + topRight.width).toBeCloseTo(card.x + card.width + clearance, 1)
      expect(bottomLeft.y + bottomLeft.height).toBeCloseTo(card.y + card.height + clearance, 1)
      expect(bottomRight.x + bottomRight.width).toBeCloseTo(card.x + card.width + clearance, 1)
      expect(topLeft.width).toBeCloseTo(7, 1)
      expect(topLeft.height).toBeCloseTo(7, 1)

      // -> Comfortably inside the catalog's 16px inset, so nothing clips them at the grid's edge
      expect(clearance).toBeLessThan(16)
    }, 60000)

    /**
     * A DOM stand-in resolves neither layout nor the logical `border-inline-end` seam property
     * `WBtnGroup` draws by default, so the on-screen distance between the two header buttons needs
     * the real browser too. Measured off the whole mounted component's HTML rather than `markup()`'s
     * catalog grid, since the header sits outside `.block-picker`.
     */
    it('takes an 8px gap between Cancel and Insert under Cobalt, and none outside it', async () => {
      const wrapper = await mountPicker()
      const html = wrapper.html()

      async function measureGap(bodyClass) {
        const page = await browser.newPage()
        try {
          await page.setContent(
            `<!doctype html><html><head><style>${css}</style></head>` +
              `<body class="${bodyClass}" style="margin:0">` +
              `<div style="width:1100px;height:800px">${html}</div></body></html>`
          )
          return await page.evaluate(() => {
            const [cancel, insert] = [
              ...document.querySelectorAll('.block-picker-actions .w-btn')
            ].map((el) => el.getBoundingClientRect())
            return Math.round(insert.left - cancel.right)
          })
        } finally {
          await page.close()
        }
      }

      expect(await measureGap('body--light')).toBe(0)
      expect(await measureGap('body--cobalt body--light')).toBe(8)
      expect(await measureGap('body--cobalt body--dark')).toBe(8)
    }, 60000)
  }
)
