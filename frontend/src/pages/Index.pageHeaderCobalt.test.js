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
 * OpenProject #2774: `.page-header` (`pages/Index.vue`) now consumes the `--page-header-*` tokens
 * `tailwind.css` declared for it (OpenProject #2767/#2771) and never had a consumer for. This is the
 * one geometry-and-paint assertion for that wiring, split from `Index.pageHeaderHeight.test.js`
 * (which is deliberately height-only, per its own docstring) since this is a different axis of the
 * same rule.
 *
 * Real browser, same reasoning as the sibling file: `background: var(--page-header-bg)` resolving to
 * a flat colour versus Ledger's plain white depending on which aesthetic's token substitutes in is
 * exactly the kind of cascade neither `jsdom` nor `happy-dom` runs.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

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

async function mountHeaderHtml() {
  const router = await createTestRouter(['/'])
  const { wrapper } = mountWithApp(PageHeader, { router })
  usePageStore().$patch({ title: 'Getting Started', description: 'How to find your way around' })
  await wrapper.vm.$nextTick()
  return wrapper.html()
}

/** Every computed value the assertions below need, for one aesthetic/theme combination. */
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
    `mountHeaderHtml()` mounts real shared components (`WBtn`, ...) that reach for the `EVENT_BUS`
    global -- `test/setup.js` rebuilds it in its own `beforeEach`, which runs before every `it()` but
    NOT before a suite's `beforeAll`. Called fresh from inside each test, after that hook, rather than
    once up front, for exactly that reason (`Index.pageHeaderHeight.test.js`'s own `mountHeaderHtml`
    calls follow the same rule).
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
      // -> The two themes' own surfaces, unchanged: `$surface` / `$dark-3`.
      expect(light.backgroundColor).not.toBe(dark.backgroundColor)
    })

    it('draws Cobalt’s flat card, margined and shadowed, with no ruled edge, in both themes', async () => {
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
        // -> No gradient (handoff 5, Part 1.1: "Banner is flat #1f4fd6 (no gradient)") -- a plain
        //    colour resolves through `background-color`, not `background-image`.
        expect(theme.backgroundImage).toBe('none')
        expect(theme.backgroundColor).toBe('rgb(31, 79, 214)')
        expect(theme.borderRadius).toBe('8px')
        expect(theme.boxShadow).not.toBe('none')
        expect(theme.borderBottomWidth).toBe('0px')
        expect(theme.marginLeft).toBe('24px')
        expect(theme.marginTop).toBe('24px')
      }
      // -> One token block covers both themes; `tailwind.css`'s Cobalt-dark block does not restate
      //    `--page-header-*`, so the flat colour itself is identical either way.
      expect(light.backgroundColor).toBe(dark.backgroundColor)
    })
  }
)
