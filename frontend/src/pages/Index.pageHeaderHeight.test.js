import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import PageHeader from '@/components/PageHeader.vue'
import { usePageStore } from '@/stores/page'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2614: the masthead's height used to depend on whether the page had a description.
 * Measured in a real Chromium before the fix, at 1280px: 129.81px with one, 108.80px without — a
 * 21px step every reader saw as the page under it jumping as they moved between pages.
 *
 * This has to be measured, not asserted about: `min-height: 96px` was not even the binding
 * constraint in the broken state (both numbers above are larger than 96), so a test reading the
 * declaration back out of the stylesheet would have said the rule was correct while the band was
 * visibly wrong. Neither `jsdom` nor `happy-dom` runs a layout engine — every
 * `getBoundingClientRect()` comes back zeroed — so this goes to a real headless Chromium, the same
 * way `ApiKeyCreateDialog.test.js`'s grid suite does. `test/realGridLayout.js` explains the probe
 * and the `{ skip: !hasChromium() }` convention; nothing is added to that module here, since the
 * measurement below is specific to this one band.
 *
 * Vertical geometry only, deliberately: task #2615 is changing what the default
 * `contentWidth: 'centered'` renders horizontally in this same file, and a width assertion here
 * would break on work that has nothing to do with this band's height.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

/**
 * The rule under test lives in an SFC `<style>` block, which `buildAppCss()` never sees — it
 * compiles `src/css/tailwind.css` alone. So both style blocks are pulled out of their `.vue` files
 * and put through `sass` with the same `_theme` / `_palette` prelude `vitest.config.js` injects into
 * every SFC.
 *
 * `PageHeader.vue`'s block is `scoped` in the app and is applied unscoped here. The fixture page
 * holds nothing but one masthead, so the two are equivalent for this measurement; what matters is
 * that the phone-breakpoint title size (`1.5rem`, declared there rather than in `Index.vue`) is
 * present, or the 390px case would measure a band that does not exist.
 */
function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  const themeDir = join(frontendRoot, 'src', 'css')
  return sass.compileString(
    `@use '${join(themeDir, '_theme.scss')}' as *;\n` +
      `@use '${join(themeDir, '_palette.scss')}' as *;\n` +
      sfcStyles(relativePath),
    { loadPaths: [join(frontendRoot, 'src')] }
  ).css
}

async function mountHeaderHtml({ title, description }) {
  const router = await createTestRouter(['/'])
  const { wrapper } = mountWithApp(PageHeader, { router })
  usePageStore().$patch({ title, description })
  await wrapper.vm.$nextTick()
  return wrapper.html()
}

/**
 * Renders one real masthead at `width` and reports the band's own box. `scrollHeight` against
 * `clientHeight` is what says whether anything inside it is being cropped — the question a fixed
 * height would have had to answer, and the reason this reports both rather than the height alone.
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
  so the exact wrap POINT is not reproducible here — which is why nothing below asserts a height for
  this case, only that the band grew to hold it rather than cropping it.
*/
const WRAPPING_TITLE =
  'A really quite extraordinarily long page title of the sort that has no chance whatsoever of ' +
  'staying on a single line however wide the window happens to be'

/*
  Launching a real Chromium, building the Tailwind stylesheet and compiling two SCSS blocks is not a
  5-second operation while seven other files are transforming beside it — same scheduling fact
  `ApiKeyCreateDialog.test.js`'s own real-layout describe records. The measurements themselves take
  milliseconds once the browser is up.
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

    // -> The defect itself: these two were 129.81 and 108.80 before the fix.
    expect(withDescription.height).toBe(withoutDescription.height)
    expect(withDescription.height).toBe(120)

    // -> Pinned, not merely tall enough to look right: nothing inside either band is cropped.
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
      The one sanctioned reason the band is not a constant: a wrapping title has nowhere to go in
      120px, and `min-height` lets it have the line rather than hiding it. See the rule's own
      comment in `Index.vue` — a fixed height here is recorded as having cropped a two-line title
      once already.
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
      `min-height: 0` on the phone breakpoint is deliberate and is NOT what this bug is about: a
      120px band under a halved icon and a 24px title is a band of empty ground. Asserted as a
      ceiling rather than an exact number, since the phone height is the sum of its contents and
      moves with any of them.
    */
    expect(phone.height).toBeLessThan(120)
    expect(phone.scrollHeight).toBeLessThanOrEqual(phone.clientHeight)
  })
})
