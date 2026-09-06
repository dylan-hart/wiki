import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

import BlockPickerOverlay from './BlockPickerOverlay.vue'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2698's two claims that are measurements rather than markup, answered in a real
 * headless Chromium page because neither `happy-dom` nor `jsdom` runs a layout engine — see
 * `test/realGridLayout.js`, which owns the Chromium probe and the app-CSS build both of these use.
 *
 *   1. The catalog holds exactly TWO cards to a row however wide the overlay gets, dropping to one
 *      below the 280px-track breakpoint. The rule that does it —
 *      `minmax(max(280px, calc(50% - 6px)), 1fr)` — caps the count by asking each track for half the
 *      row less its share of the gap, which nothing can fit three of. That is reasoning about a
 *      `calc()` inside a `max()` inside a `minmax()`, and reasoning is exactly what a test should
 *      not be standing in for.
 *   2. NOTHING reflows as selection moves between cards. Selection here is an accent hairline, four
 *      corner marks and a tinted icon plate, all drawn in line weight; the geometry that makes it
 *      free is that an unselected card already carries a 1px border, the selected one's extra weight
 *      is an INSET shadow, and the marks are absolutely positioned. Every one of those is a
 *      property a static reading of the stylesheet can get wrong, so this measures the boxes
 *      instead: every card's rect, and every corner mark's rect, before and after selection moves.
 *
 * `BlockPickerOverlay.vue`'s own `<style lang="scss">` is compiled here alongside the app's
 * stylesheet. `buildAppCss()` compiles `src/css/tailwind.css` only, which is where the reset, the
 * utilities and every `--color-*` token live but NOT a single SFC's scoped rules — and this card is
 * drawn entirely by the SFC. The prelude matches `vitest.config.js`'s own
 * `css.preprocessorOptions.scss.additionalData`, since the block reaches for bare `$ink` / `$text-*`.
 */

const selfDir = dirname(fileURLToPath(import.meta.url))
const cssDir = join(selfDir, '..', 'css')
const componentPath = join(selfDir, 'BlockPickerOverlay.vue')

/** Enough blocks to fill three rows at two per row, so a third column would be visible as a shortfall. */
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
  const scss = source.match(/<style lang="scss">([\s\S]*?)<\/style>/)[1]
  const compiled = await sass.compileStringAsync(
    `@use 'theme' as *;\n@use 'palette' as *;\n${scss}`,
    { loadPaths: [cssDir] }
  )
  return compiled.css
}

async function mountPicker() {
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(BLOCKS) })
  const { wrapper } = mountWithApp(BlockPickerOverlay)
  await flushPromises()
  return wrapper
}

/**
 * Renders the catalog grid exactly as mounted, at a fixed track width, and reads back where the
 * browser actually put every card and every corner mark. Rounded to a hundredth of a pixel: two
 * renders of identical markup agree exactly, and sub-hundredth noise would only ever be a
 * sub-pixel rounding artefact, never the whole-pixel shift a border adds.
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

/** How many distinct rows the cards landed on, and the widest row's card count. */
function rowShape(cards) {
  const rows = new Map()
  for (const card of cards) {
    rows.set(card.y, (rows.get(card.y) ?? 0) + 1)
  }
  return { rows: rows.size, widest: Math.max(...rows.values()) }
}

/*
 * Launching a real Chromium and compiling the app's whole stylesheet are both slow next to the rest
 * of the suite, which vitest runs across eight workers beside this one -- hence the raised
 * describe-level and per-test timeouts, matching what `ApiKeyCreateDialog.test.js` already needs.
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
     * Mounted from inside a test rather than in `beforeAll`: `test/setup.js` rebuilds the `API_CLIENT`
     * stub in a `beforeEach`, so it does not exist yet while `beforeAll` runs. Memoized, because the
     * markup is identical for every measurement below and mounting it once is the point.
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
     * 940px is roughly the catalog's track inside a full-bleed overlay on a 1440px screen, 640px what
     * it gets on a laptop, and 580px the narrowest width that still holds two 280px tracks plus the
     * gap. All three must be two-up: the whole point of the `max()` is that widening the overlay adds
     * width to the two cards rather than a third column.
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
     * The hard requirement. `selectedFirstHtml` and `selectedSecondHtml` differ only in which card
     * carries `is-selected`, so any difference in the rects is the selection treatment costing
     * layout — which is precisely what the 2.x glow-to-hairline change had to avoid reintroducing.
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
      // -> The marks are out of flow in every state, so they sit in the same 20 places throughout
      expect(first.marks).toEqual(unpicked.marks)
      expect(second.marks).toEqual(unpicked.marks)
      expect(unpicked.marks).toHaveLength(BLOCKS.length * 4)
    }, 60000)

    /**
     * The corner marks overhang the card, and must land OUTSIDE its box without being clipped by, or
     * pushing aside, anything around them — which is what the catalog's own 16px inset and the grid's
     * 12px gap are big enough to absorb.
     *
     * The `-4px` each corner is offset by is measured from the card's PADDING box, since that is the
     * containing block an absolutely-positioned child of a `position: relative` element resolves
     * against. The card's hairline is 1px, so the mark clears its BORDER box — the edge a reader
     * actually sees, and the one `getBoundingClientRect` reports — by 3px. Asserted at that number
     * rather than at 4 because 3 is the true measurement; a test written to the CSS literal instead
     * of to the rendered result is the thing a real browser is here to prevent.
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
  }
)
