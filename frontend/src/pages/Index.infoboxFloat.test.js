import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, hasChromium } from '../../test/realGridLayout.js'

const pagesDir = dirname(fileURLToPath(import.meta.url))

const COLUMN_WIDTH = 1200
const INFOBOX_HEIGHT = 600
const SEPARATOR_GAP = 24

async function indexPageStyle() {
  const sfc = await readFile(join(pagesDir, 'Index.vue'), 'utf8')
  const block = sfc.match(/<style>([\s\S]*?)<\/style>/)
  expect(block, 'Index.vue should still carry a `<style>` block').not.toBeNull()
  return block[1]
}

function articleMarkup({ measured, withRelations, withComments }) {
  return (
    `<div style="width:${COLUMN_WIDTH}px">` +
    `<div class="page-container-scrl">` +
    `<div class="page-container-body${measured ? ' is-measured' : ''}">` +
    `<div class="page-contents">` +
    `<block-infobox style="display:block;float:right;width:300px;height:${INFOBOX_HEIGHT}px;z-index:1;position:relative">Fact box</block-infobox>` +
    `<p>Short page.</p>` +
    `</div>` +
    (withRelations
      ? `<hr class="w-separator relations-separator" style="margin:${SEPARATOR_GAP}px 0;height:1px;border:0;background:#000">` +
        `<div class="relations">Related</div>`
      : '') +
    (withComments
      ? `<hr class="w-separator comments-separator" style="margin:${SEPARATOR_GAP}px 0;height:1px;border:0;background:#000">` +
        `<div class="page-comments-measure"><div class="comments-inner">Comments</div></div>`
      : '') +
    `</div></div></div>`
  )
}

async function layOut(browser, css, options) {
  const page = await browser.newPage({ viewport: { width: COLUMN_WIDTH, height: 900 } })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}` +
        `${css}</style></head><body>${articleMarkup(options)}</body></html>`
    )
    return await page.evaluate(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector)
        return el ? el.getBoundingClientRect().toJSON() : null
      }
      return {
        contents: rect('.page-contents'),
        infobox: rect('block-infobox'),
        relationsSeparator: rect('.relations-separator'),
        commentsSeparator: rect('.comments-separator'),
        comments: rect('.page-comments-measure')
      }
    })
  } finally {
    await page.close()
  }
}

describe('Index.vue article contains a floated infobox', () => {
  it('makes `.page-contents` a block formatting context in the article column', async () => {
    const css = await indexPageStyle()
    const rule = css.match(/\n {2}> \.page-contents \{[^}]*\}/)

    expect(
      rule,
      'Index.vue should still style `.page-container-body > .page-contents`'
    ).not.toBeNull()
    expect(rule[0]).toMatch(/display:\s*flow-root/)
  })

  describe('in a real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser
    let css

    beforeAll(async () => {
      browser = await chromium.launch()
      css = await indexPageStyle()
    })

    afterAll(async () => {
      await browser?.close()
    })

    for (const measured of [true, false]) {
      it(`grows \`.page-contents\` to the infobox's height (measured: ${measured})`, async () => {
        const rects = await layOut(browser, css, {
          measured,
          withRelations: true,
          withComments: true
        })

        expect(rects.contents.bottom).toBeGreaterThanOrEqual(rects.infobox.bottom)
      })

      it(`starts the relations separator below the infobox (measured: ${measured})`, async () => {
        const rects = await layOut(browser, css, {
          measured,
          withRelations: true,
          withComments: true
        })

        expect(rects.relationsSeparator.top).toBeGreaterThanOrEqual(
          rects.infobox.bottom + SEPARATOR_GAP
        )
        expect(rects.commentsSeparator.top).toBeGreaterThan(rects.infobox.bottom)
      })

      it(`starts the comments separator and comments below the infobox with no relations (measured: ${measured})`, async () => {
        const rects = await layOut(browser, css, {
          measured,
          withRelations: false,
          withComments: true
        })

        expect(rects.commentsSeparator.top).toBeGreaterThanOrEqual(
          rects.infobox.bottom + SEPARATOR_GAP
        )
        expect(rects.comments.top).toBeGreaterThan(rects.infobox.bottom)
      })
    }

    it('keeps the infobox floated beside the text rather than pushed below it', async () => {
      const rects = await layOut(browser, css, {
        measured: true,
        withRelations: false,
        withComments: true
      })

      expect(rects.infobox.top).toBe(rects.contents.top)
      expect(rects.infobox.right).toBe(rects.contents.right)
    })
  })
})
