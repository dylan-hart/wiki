import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { listSourceFiles } from '../../test/sourceFiles.js'

/**
 * `.w-section-header` -- the band that opens a card, a settings group or a side-panel section -- is
 * the app's one section rhythm: a 34px strip with its text 16px in from the edge, then `14px 16px` of
 * body under it (`ui-redesign/Cardinal Wiki - Page Properties 3x.dc.html`).
 *
 * The recurring review note through both re-skin passes was "odd padding not matching the mockups",
 * and every instance of it was the same shape: a call site restating the band's own metrics in its
 * own numbers -- eleven dialog headers drawing the band at `px-4 py-2`, a page paying for its top
 * spacing out of the band's `padding-top`, a body inset at `px-5` under a heading inset at 16px. The
 * numbers only ever drifted apart because they were written down twice.
 *
 * So this guards the rhythm from both ends. The measurement is a real headless Chromium page,
 * because a computed height is a measured thing and neither `jsdom` nor `happy-dom` runs a layout
 * engine (see `test/realGridLayout.js`). The source scan is what the measurement cannot do: three
 * synthetic container shapes cannot notice a fourth real file re-tuning the band next month.
 */

const srcRoot = join(import.meta.dirname, '..')

/** The design's numbers, in one place, so a failure names what it expected and where that came from. */
const BAND_HEIGHT = 34
const BAND_INSET = 16
const BAND_TRAILING_GAP = 14

/**
 * The container shapes the app actually puts a band in, each reduced to the markup that makes it
 * that shape. The last one is the box that pads itself and hands the inset back through
 * `--w-section-bleed`; its band's edges have to land on the outer container's, not 16px inside them.
 */
const SHAPES = [
  {
    name: 'first child of an unpadded card (WCard + WCardHeader -- AdminGeneral, EditorRedirect)',
    html: `
      <div class="w-card">
        <h2 class="w-card-header w-section-header"><div class="w-card-header__row">Site info</div></h2>
        <div class="p-4">Body</div>
      </div>`
  },
  {
    name: 'bare band opening an unpadded panel (InboxWatching, InboxReview, TagsBrowse)',
    html: `
      <div class="w-page">
        <div class="w-section-header">Pending review</div>
        <div class="px-4 pb-4">Body</div>
      </div>`
  },
  {
    name: 'second band mid-panel, spaced by mt-6 (ProfileInfo, InboxWatching)',
    html: `
      <div class="w-page">
        <div class="px-4 pb-4">Body</div>
        <div class="w-section-header mt-6">Preferences</div>
        <div class="px-4 pb-4">Body</div>
      </div>`
  },
  {
    name: 'inside a padded box that hands the inset back (PageRelationDialog, TableEditorOverlay)',
    html: `
      <div style="--w-section-bleed: 16px">
        <div class="p-4">
          <div class="w-section-header">Target</div>
          <div>Body</div>
        </div>
      </div>`
  }
]

describe('.w-section-header renders one rhythm in a real browser', { skip: !hasChromium() }, () => {
  let measured

  beforeAll(async () => {
    const css = await buildAppCss()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body style="margin:0">` +
          SHAPES.map(
            (shape, index) =>
              `<div class="shape" data-index="${index}" style="width:520px">${shape.html}</div>`
          ).join('') +
          `</body></html>`
      )
      measured = await page.evaluate(() =>
        [...document.querySelectorAll('.shape')].map((shape) => {
          const band = shape.querySelector('.w-section-header')
          const style = getComputedStyle(band)
          const bandRect = band.getBoundingClientRect()
          const shapeRect = shape.getBoundingClientRect()
          return {
            height: bandRect.height,
            paddingInlineStart: style.paddingInlineStart,
            paddingInlineEnd: style.paddingInlineEnd,
            marginBlockEnd: style.marginBlockEnd,
            fontSize: style.fontSize,
            insetStart: bandRect.left - shapeRect.left,
            insetEnd: shapeRect.right - bandRect.right
          }
        })
      )
      await page.close()
    } finally {
      await browser.close()
    }
  }, 60000)

  afterAll(() => {
    measured = undefined
  })

  it('measures a band in every shape', () => {
    expect(measured).toHaveLength(SHAPES.length)
  })

  it.each(SHAPES.map((shape, index) => [shape.name, index]))(
    'is 34px tall with its text 16px in, as a %s',
    (_name, index) => {
      const band = measured[index]
      expect({
        height: band.height,
        start: band.paddingInlineStart,
        end: band.paddingInlineEnd
      }).toEqual({
        height: BAND_HEIGHT,
        start: `${BAND_INSET}px`,
        end: `${BAND_INSET}px`
      })
    }
  )

  it('trails the design rhythm everywhere, so the body under it never adds a second gap', () => {
    for (const band of measured) {
      expect(band.marginBlockEnd).toBe(`${BAND_TRAILING_GAP}px`)
    }
  })

  it('reaches its container edges, whether that container pads itself or not', () => {
    measured.forEach((band, index) => {
      /*
       * A bleeding band's own inline margin cancels its parent's padding exactly, so its edges land
       * on the OUTER container's -- which is the whole point of the band being full-bleed, and the
       * thing every hand-written `-mx-4` was reaching for.
       */
      expect({ shape: SHAPES[index].name, start: band.insetStart, end: band.insetEnd }).toEqual({
        shape: SHAPES[index].name,
        start: 0,
        end: 0
      })
    })
  })

  it('leaves every band on the same type', () => {
    expect([...new Set(measured.map((band) => band.fontSize))]).toEqual(['10px'])
  })
})

/*
 * The band's metrics are written down once, in `css/tailwind.css`. These two scans are what stops a
 * second copy appearing: the first catches a padding utility on the element itself (`px-4 py-2`,
 * `pt-4`), the second catches a component stylesheet re-tuning the class.
 */
describe("no call site restates the band's own metrics", () => {
  const sources = listSourceFiles(srcRoot, {
    ext: ['.vue'],
    skip: (full) => full.includes('.test.')
  })

  /**
   * Both scans read an SFC with its comments taken out first. Every file in this codebase explains
   * itself at length, and several of those explanations name the very thing being looked for: a
   * block comment mentioning `.w-section-header`, sitting directly above an unrelated
   * `.w-card-section` rule that does set padding, is a match for any regex that has to span from a
   * class name to the next brace. Verified, not guessed -- `PagePropertiesDialog.vue` and
   * `pages/Index.vue` both failed this scan on their prose alone before the strip went in, and a
   * comment mentioning the band is exactly what this Task's own diff added more of.
   */
  const withoutComments = (file) =>
    readFileSync(file, 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
      .replaceAll(/<!--[\s\S]*?-->/g, ' ')

  it('finds the call sites it is scanning', () => {
    const callers = sources.filter((file) => {
      const text = withoutComments(file)
      return text.includes('w-section-header') || text.includes('<w-card-header')
    })
    expect(callers.length).toBeGreaterThan(15)
  })

  it('puts no padding utility on an element carrying the band', () => {
    const offenders = []
    for (const file of sources) {
      const text = withoutComments(file)
      /*
       * Every element whose class list mentions the band, plus every `<w-card-header ...>` opening
       * tag (its root carries the class), matched against the padding utilities Tailwind spells --
       * `p-`, `px-`, `py-`, `pt-`, `pb-`, `ps-`, `pe-`, and their `sm:`/`dark:`-prefixed forms.
       */
      const elements = [
        ...text.matchAll(/class="[^"]*\bw-section-header\b[^"]*"/g),
        ...text.matchAll(/<w-card-header\b[^>]*>/g)
      ].map((match) => match[0])
      for (const element of elements) {
        const padding = element.match(/\b(?:[a-z]+:)*p[xytbse]?-[a-z0-9.[\]/-]+/g)
        if (padding) offenders.push(`${file.slice(srcRoot.length + 1)}: ${padding.join(' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('sets no padding on .w-section-header from a component stylesheet', () => {
    const offenders = []
    for (const file of sources) {
      const text = withoutComments(file)
      /*
       * A `.w-section-header { ... }` rule anywhere in an SFC's style block. Margin is allowed and
       * expected -- a band cancels its container's inset, and suppresses its own trailing gap where
       * the container's own gap already provides it -- but padding IS the band's height and text
       * inset, which is the thing that has to stay identical everywhere.
       */
      for (const rule of text.matchAll(/\.w-section-header[^{}]*\{([^{}]*)\}/g)) {
        const padding = rule[1].match(/(?:^|[\s;])padding[a-z-]*\s*:/g)
        if (padding) {
          offenders.push(`${file.slice(srcRoot.length + 1)}: ${padding.join(' ').trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
