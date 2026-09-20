import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import PageHeader from '@/components/PageHeader.vue'
import { usePageStore } from '@/stores/page'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * The masthead's height has to be MEASURED, not asserted about: `min-height` need not be the
 * binding constraint, so a test reading the declaration back out of the stylesheet can call the rule
 * correct while the band is visibly wrong. Neither `jsdom` nor `happy-dom` runs a layout engine —
 * every `getBoundingClientRect()` comes back zeroed — so this goes to a real headless Chromium.
 *
 * Vertical geometry only, deliberately: a width assertion here would break on horizontal work that
 * has nothing to do with this band's height.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

/**
 * `buildAppCss()` compiles `src/css/tailwind.css` alone and never sees an SFC `<style>` block, so
 * both are pulled out of their `.vue` files directly. `PageHeader.vue`'s is `scoped` in the app and
 * applied unscoped here: the fixture page holds nothing but one masthead, so the two are equivalent,
 * and it is what carries the phone-breakpoint title size the 390px case needs.
 */
function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> No compile step: every SFC `<style>` block is plain CSS, native nesting included, which the
  //    real Chromium below parses as-is.
  return sfcStyles(relativePath)
}

async function mountHeaderHtml({ title, description }) {
  const router = await createTestRouter(['/'])
  const { wrapper } = mountWithApp(PageHeader, { router })
  usePageStore().$patch({ title, description })
  await wrapper.vm.$nextTick()
  return wrapper.html()
}

/**
 * `scrollHeight` against `clientHeight` is what says whether anything inside the band is being
 * cropped — the question a pinned height has to answer — hence both, not the height alone.
 */
async function measureHeader({ browser, css, html, width }) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="body--light" style="margin:0">${html}</body></html>`
    )
    return await page.evaluate(() => {
      const el = document.querySelector('.page-header')
      return {
        height: el.getBoundingClientRect().height,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight
      }
    })
  } finally {
    await page.close()
  }
}

const SHORT_TITLE = 'Getting Started'
const DESCRIPTION = 'How to find your way around this wiki'
/*
  Long enough to wrap under any face. Barlow is a webfont and is not installed in headless Chromium,
  so the exact wrap POINT is not reproducible — which is why nothing below asserts a height for this
  case, only that the band grew to hold it.
*/
const WRAPPING_TITLE =
  'A really quite extraordinarily long page title of the sort that has no chance whatsoever of ' +
  'staying on a single line however wide the window happens to be'

/*
  The long timeout is for the launch: starting a real Chromium and building the stylesheet while
  other files transform beside it is not a 5-second operation. The measurements take milliseconds.
*/
describe('page header band height — real layout', { skip: !hasChromium(), timeout: 60000 }, () => {
  let browser
  let css

  beforeAll(async () => {
    browser = await chromium.launch()
    css = [
      await buildAppCss(),
      compileSfcStyles(join('src', 'pages', 'Index.vue')),
      compileSfcStyles(join('src', 'components', 'PageHeader.vue'))
    ].join('\n')
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('is exactly 120px on desktop, with or without a page description', async () => {
    const withDescription = await measureHeader({
      browser,
      css,
      html: await mountHeaderHtml({ title: SHORT_TITLE, description: DESCRIPTION }),
      width: 1280
    })
    const withoutDescription = await measureHeader({
      browser,
      css,
      html: await mountHeaderHtml({ title: SHORT_TITLE, description: '' }),
      width: 1280
    })

    expect(withDescription.height).toBe(withoutDescription.height)
    expect(withDescription.height).toBe(120)

    expect(withDescription.scrollHeight).toBeLessThanOrEqual(withDescription.clientHeight)
    expect(withoutDescription.scrollHeight).toBeLessThanOrEqual(withoutDescription.clientHeight)
  })

  it('grows past 120px for a title long enough to wrap, rather than cropping it', async () => {
    const wrapped = await measureHeader({
      browser,
      css,
      html: await mountHeaderHtml({ title: WRAPPING_TITLE, description: DESCRIPTION }),
      width: 1280
    })

    /*
      The one sanctioned reason the band is not a constant: `min-height`, not a fixed height, is
      what lets a second title line exist instead of being cropped.
    */
    expect(wrapped.height).toBeGreaterThan(120)
    expect(wrapped.scrollHeight).toBeLessThanOrEqual(wrapped.clientHeight)
  })

  it('stays contents-sized on a phone, well under the desktop band', async () => {
    const phone = await measureHeader({
      browser,
      css,
      html: await mountHeaderHtml({ title: SHORT_TITLE, description: DESCRIPTION }),
      width: 390
    })

    /*
      `min-height: 0` on the phone breakpoint is deliberate -- a 120px band under a halved icon and a
      24px title is empty ground. A ceiling, not an exact number, since the phone band is the sum of
      its contents and moves with any of them.
    */
    expect(phone.height).toBeLessThan(120)
    expect(phone.scrollHeight).toBeLessThanOrEqual(phone.clientHeight)
  })
})
