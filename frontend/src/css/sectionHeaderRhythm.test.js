import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { listSourceFiles } from '../../test/sourceFiles.js'

/**
 * `.w-section-header` -- the band that opens a card, a settings group or a side-panel section -- is
 * the app's one section rhythm, and it drifts whenever a call site writes its metrics down a second
 * time in its own numbers.
 *
 * Guarded from both ends. The measurement needs a real headless Chromium page, because a computed
 * height is a measured thing and neither `jsdom` nor `happy-dom` runs a layout engine. The source
 * scan is what the measurement cannot do: a handful of synthetic shapes cannot notice some other
 * file re-tuning the band.
 */

const srcRoot = join(import.meta.dirname, '..')

const BAND_HEIGHT = 34
const BAND_INSET = 16
const BAND_TRAILING_GAP = 14

// The container shapes the app really puts a band in, each reduced to the markup that makes it that
// shape -- the last being the one that pads itself and hands the inset back via `--w-section-bleed`.
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

describe(
  '.w-section-header renders one rhythm in a real browser',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
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
        // A bleeding band's own inline margin cancels its parent's padding exactly, so its edges
        // land on the OUTER container's -- what a hand-written `-mx-4` is reaching for.
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
  }
)

// The band's metrics are written down once, in `css/tailwind.css`; these scans are what stops a
// second copy appearing.
describe("no call site restates the band's own metrics", () => {
  const sources = listSourceFiles(srcRoot, {
    ext: ['.vue'],
    skip: (full) => full.includes('.test.')
  })

  /**
   * Comments come out first, or the scans match prose: a block comment mentioning
   * `.w-section-header` directly above an unrelated rule that does set padding satisfies any regex
   * spanning from a class name to the next brace. Real files have failed on their prose alone.
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
      // `<w-card-header>` is in scope too: its own root element carries the band class.
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
       * Margin is allowed and expected -- a band cancels its container's inset, and suppresses its
       * own trailing gap where the container already provides one -- but padding IS the band's
       * height and text inset, the thing that has to stay identical everywhere.
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
