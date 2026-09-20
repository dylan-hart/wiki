import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import PageHeader from '@/components/PageHeader.vue'
import { usePageStore } from '@/stores/page'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * `.page-header`'s paint and geometry from the `--page-header-*` tokens; height is
 * `Index.pageHeaderHeight.test.js`'s. Real browser, because which aesthetic's token substitutes into
 * `background: var(--page-header-bg)` is exactly the cascade neither `jsdom` nor `happy-dom` runs.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> No compile step: every SFC `<style>` block is plain CSS, native nesting included, which the
  //    real Chromium below parses as-is.
  return sfcStyles(relativePath)
}

async function mountHeaderHtml() {
  const router = await createTestRouter(['/'])
  const { wrapper } = mountWithApp(PageHeader, { router })
  usePageStore().$patch({ title: 'Getting Started', description: 'How to find your way around' })
  await wrapper.vm.$nextTick()
  return wrapper.html()
}

async function measureHeader({ browser, css, html, bodyClasses }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">${html}</body></html>`
    )
    return await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('.page-header'))
      return {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderTopLeftRadius,
        boxShadow: style.boxShadow,
        borderBottomWidth: style.borderBottomWidth,
        marginLeft: style.marginLeft,
        marginTop: style.marginTop
      }
    })
  } finally {
    await page.close()
  }
}

describe(
  'page header banner tokens — real layout',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let css

    /*
    `mountHeaderHtml()` mounts real shared components that reach for the `EVENT_BUS` global, which
    `test/setup.js` rebuilds in a `beforeEach` -- that runs before every `it()` but NOT before a
    suite's `beforeAll`, so each test calls it fresh instead of sharing one mount from up here.
  */
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

    it('stays Ledger’s flush white plate, in both themes', async () => {
      const html = await mountHeaderHtml()
      const light = await measureHeader({ browser, css, html, bodyClasses: 'body--light' })
      const dark = await measureHeader({ browser, css, html, bodyClasses: 'body--dark' })

      for (const theme of [light, dark]) {
        expect(theme.backgroundImage).toBe('none')
        expect(theme.borderRadius).toBe('0px')
        expect(theme.boxShadow).toBe('none')
        expect(theme.marginLeft).toBe('0px')
        expect(theme.marginTop).toBe('0px')
        expect(theme.borderBottomWidth).toBe('1px')
      }
      // -> Each theme keeps its own surface colour, so the plate is not a fixed fill.
      expect(light.backgroundColor).not.toBe(dark.backgroundColor)
    })

    it('draws Cobalt’s flat card, margined and matte, with no ruled edge, in both themes', async () => {
      const html = await mountHeaderHtml()
      const light = await measureHeader({
        browser,
        css,
        html,
        bodyClasses: 'body--light body--cobalt'
      })
      const dark = await measureHeader({
        browser,
        css,
        html,
        bodyClasses: 'body--dark body--cobalt'
      })

      for (const theme of [light, dark]) {
        // -> A flat fill resolves through `background-color`, so a gradient would show up here.
        expect(theme.backgroundImage).toBe('none')
        expect(theme.backgroundColor).toBe('rgb(31, 79, 214)')
        expect(theme.borderRadius).toBe('8px')
        expect(theme.boxShadow).toBe('none')
        expect(theme.borderBottomWidth).toBe('0px')
        expect(theme.marginLeft).toBe('24px')
        // -> `--page-header-margin-block-start` has its own token, split from the horizontal 24px,
        //    but resolves to 0 -- the banner sits flush with the top, as in Ledger.
        expect(theme.marginTop).toBe('0px')
      }
      // -> `tailwind.css`'s Cobalt-dark block does not restate `--page-header-*`, so one token block
      //    covers both themes.
      expect(light.backgroundColor).toBe(dark.backgroundColor)
    })
  }
)
