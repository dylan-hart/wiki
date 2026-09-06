import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

import { chromium, hasChromium } from '../../test/realGridLayout.js'

/*
 * The article column's measure -- what `contentWidth: 'measured'` actually renders.
 *
 * The design (`ui-redesign/Cardinal Wiki - Ledger 3x.dc.html`) writes the article column as a padded
 * box holding a bare `<div style="max-width:720px">`, with no `margin: 0 auto` anywhere in the file:
 * the text stops at 720px but STARTS where the column's padding does, flush with the breadcrumbs and
 * header above it. The app centred it instead (`margin-inline: auto`), which read as a drifting,
 * centre-aligned article on a wide window -- OpenProject #2615.
 *
 * "Left edge at the padding edge, not at (columnWidth - 720) / 2" is a statement about real layout,
 * so nothing short of a real layout engine can answer it: under `happy-dom` (this suite's
 * environment) every `getBoundingClientRect()` comes back zeroed regardless of CSS, and a test
 * asserting on the style string instead would pass just as happily with the `margin-inline` still
 * there. So this drives a real headless Chromium page, the way `test/realGridLayout.js` documents.
 *
 * It does NOT go through `buildAppCss()`, though: the rule under test lives in `Index.vue`'s own
 * un-scoped `<style lang="scss">` block, not in Tailwind's output. The block is read out of the SFC
 * and compiled with the same `@use` injection `vitest.config.js`'s `css.preprocessorOptions.scss`
 * performs, so what the browser lays out is the file's real, compiled CSS -- a rule deleted or
 * renamed in `Index.vue` stops being applied here too, rather than silently passing against a copy.
 */

const pagesDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = join(pagesDir, '..', '..')

/* -> Wide enough that centring and left-aligning are far apart: 1200 - 56 padding = 1144 of column,
      so a centred 720px measure would sit 212px in from the padding edge. */
const COLUMN_WIDTH = 1200
const COLUMN_PADDING_INLINE = 28
const MEASURE = 720

async function indexPageCss() {
  const sfc = await readFile(join(pagesDir, 'Index.vue'), 'utf8')
  const block = sfc.match(/<style lang="scss">([\s\S]*?)<\/style>/)
  expect(block, 'Index.vue should still carry a `<style lang="scss">` block').not.toBeNull()
  const compiled = await sass.compileStringAsync(
    `@use 'css/_theme.scss' as *; @use 'css/_palette.scss' as *;\n` + block[1],
    { loadPaths: [join(frontendRoot, 'src')] }
  )
  return compiled.css
}

/*
 * The article column exactly as `Index.vue`'s template builds it (`:141-155`): the scroll area, the
 * padded body carrying the conditional class, and the `v-html` contents div inside it.
 */
function columnMarkup({ measured }) {
  return (
    `<div style="width:${COLUMN_WIDTH}px">` +
    `<div class="page-container-scrl" style="height:100%">` +
    `<div class="page-container-body${measured ? ' is-measured' : ''}">` +
    `<div class="page-contents"><p>Prerequisites</p></div>` +
    `</div></div></div>`
  )
}

async function measureContents(browser, css, { measured }) {
  const page = await browser.newPage({ viewport: { width: COLUMN_WIDTH, height: 800 } })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}` +
        `${css}</style></head><body>${columnMarkup({ measured })}</body></html>`
    )
    return await page.evaluate(() => {
      const body = document.querySelector('.page-container-body').getBoundingClientRect()
      const contents = document.querySelector('.page-contents').getBoundingClientRect()
      return { bodyLeft: body.x, bodyWidth: body.width, left: contents.x, width: contents.width }
    })
  } finally {
    await page.close()
  }
}

describe(
  'Index.vue article measure, in a real browser',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let css

    beforeAll(async () => {
      browser = await chromium.launch()
      css = await indexPageCss()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('holds measured content to 720px flush against the column padding, not centred', async () => {
      const rect = await measureContents(browser, css, { measured: true })

      expect(rect.width).toBe(MEASURE)
      /* -> The whole point: the leading edge is the column's padding edge... */
      expect(rect.left - rect.bodyLeft).toBe(COLUMN_PADDING_INLINE)
      /* -> ...and specifically NOT half the leftover, which is what `margin-inline: auto` produced. */
      const centredLeft =
        COLUMN_PADDING_INLINE + (rect.bodyWidth - COLUMN_PADDING_INLINE * 2 - MEASURE) / 2
      expect(centredLeft).toBeGreaterThan(COLUMN_PADDING_INLINE)
      expect(rect.left - rect.bodyLeft).not.toBe(centredLeft)
    })

    it('lets unmeasured content fill the padded column, so the toggle still does something', async () => {
      const rect = await measureContents(browser, css, { measured: false })

      expect(rect.left - rect.bodyLeft).toBe(COLUMN_PADDING_INLINE)
      expect(rect.width).toBe(COLUMN_WIDTH - COLUMN_PADDING_INLINE * 2)
      expect(rect.width).toBeGreaterThan(MEASURE)
    })
  }
)

/*
 * The rule and the class binding have to agree, and both have to spell the same value the store
 * defaults to -- three separate files. A rename that missed one would leave the measure permanently
 * off with nothing failing above, since the real-browser suite drives the class directly.
 */
describe('Index.vue measure wiring', () => {
  it('binds `is-measured` off `contentWidth === measured`, the store default', async () => {
    const sfc = await readFile(join(pagesDir, 'Index.vue'), 'utf8')
    const store = await readFile(join(frontendRoot, 'src', 'stores', 'site.js'), 'utf8')

    expect(sfc).toContain("'is-measured': siteStore.theme.contentWidth === `measured`")
    expect(sfc).toContain('.page-container-body.is-measured > .page-contents')
    expect(store).toContain("contentWidth: 'measured'")
  })

  it('does not centre the measure', async () => {
    const css = await indexPageCss()
    const rule = css.match(/\.page-container-body\.is-measured > \.page-contents \{[^}]*\}/)

    expect(rule).not.toBeNull()
    expect(rule[0]).toContain('max-width: 720px')
    expect(rule[0]).not.toMatch(/margin-inline:\s*auto|margin:\s*0 auto/)
  })
})
