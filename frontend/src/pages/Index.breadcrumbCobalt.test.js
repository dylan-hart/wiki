import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sass from 'sass'

import WBreadcrumbs from '@/components/shared/WBreadcrumbs.vue'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2975 (Cobalt typography role-table conformance, "Breadcrumb bar" row):
 * `WBreadcrumbs.vue` renders its `active-color`/`separator-color` props as literal inline `color`
 * styles (`activeStyle`/`separatorStyle`) -- Ledger greys, regardless of aesthetic -- which outrank
 * anything `Index.vue`'s `.page-breadcrumbs` stylesheet rule sets for every crumb but the last (an
 * inline style beats a stylesheet declaration of ordinary importance). This is the one geometry-free,
 * paint-only assertion for the four §3 roles: trail segment, current segment, separator, and the
 * "Last modified" note.
 *
 * Real browser, same reasoning as `Index.pageHeaderCobalt.test.js` and `Index.breadcrumbBand.test.js`:
 * `getComputedStyle` resolving a CSS custom property through the cascade -- and an inline style vs. a
 * stylesheet rule's relative priority -- is exactly what neither `jsdom` nor `happy-dom` runs.
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

/**
 * The breadcrumb band as `Index.vue` actually renders it: `WBreadcrumbs` with the same
 * `active-color`/`separator-color`/separator-icon-slot props the page passes, plus the sibling
 * "Last modified" note div -- both live inside the same `.page-breadcrumbs` band and the note's
 * colour rule is unscoped (applies through both aesthetics), so it belongs in this same fixture.
 */
async function mountBreadcrumbsHtml() {
  const router = await createTestRouter(['/', '/docs', '/docs/getting-started'])
  const { wrapper } = mountWithApp(WBreadcrumbs, {
    router,
    props: {
      items: [
        { key: 'home', icon: 'tabler:home', to: '/', ariaLabel: 'Home' },
        { key: 'docs', label: 'Docs', to: '/docs' },
        { key: 'page', label: 'Getting started' }
      ],
      activeColor: 'grey-7',
      separatorColor: 'grey'
    },
    slots: {
      separator: '<w-icon name="tabler:chevron-right" />'
    }
  })
  await wrapper.vm.$nextTick()
  return (
    '<div class="page-breadcrumbs px-4 flex flex-wrap items-center">' +
    `<div class="min-w-0 flex-1">${wrapper.html()}</div>` +
    '<div class="flex-none items-center justify-end hidden sm:flex">' +
    '<div class="page-breadcrumbs-modified">Last modified 2 hours ago</div>' +
    '</div>' +
    '</div>'
  )
}

/** Every computed value the four role-table rows need, for one aesthetic/theme combination. */
async function measureBreadcrumbs({ browser, css, html, bodyClasses }) {
  const page = await browser.newPage()
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClasses}" style="margin:0">${html}</body></html>`
    )
    return await page.evaluate(() => {
      const read = (el) => {
        const s = getComputedStyle(el)
        return {
          color: s.color,
          fontFamily: s.fontFamily,
          fontSize: s.fontSize,
          fontWeight: s.fontWeight
        }
      }
      const els = [...document.querySelectorAll('.page-breadcrumbs .w-breadcrumbs__el')]
      const current = els.find((el) => el.getAttribute('aria-current') === 'page')
      const trailSegment = els.find((el) => el.getAttribute('aria-current') !== 'page')
      const separator = document.querySelector('.page-breadcrumbs .w-breadcrumbs__separator')
      const modified = document.querySelector('.page-breadcrumbs-modified')
      return {
        trailSegment: read(trailSegment),
        current: read(current),
        separator: read(separator),
        modified: read(modified)
      }
    })
  } finally {
    await page.close()
  }
}

describe(
  'breadcrumb bar Cobalt typography — real layout (OpenProject #2975)',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let css
    let html

    beforeAll(async () => {
      browser = await chromium.launch()
      css = [
        await buildAppCss(),
        compileSfcStyles(join('src', 'pages', 'Index.vue')),
        compileSfcStyles(join('src', 'components', 'shared', 'WBreadcrumbs.vue'))
      ].join('\n')
      html = await mountBreadcrumbsHtml()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('draws every role at 400/500 11.5px Roboto Mono, in both themes', async () => {
      const light = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--light body--cobalt'
      })
      const dark = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--dark body--cobalt'
      })

      for (const theme of [light, dark]) {
        for (const role of [theme.trailSegment, theme.current, theme.separator, theme.modified]) {
          expect(role.fontFamily.split(',')[0].replaceAll('"', '')).toBe('Roboto Mono')
          expect(role.fontSize).toBe('11.5px')
        }
        expect(theme.trailSegment.fontWeight).toBe('400')
        expect(theme.current.fontWeight).toBe('500')
        expect(theme.modified.fontWeight).toBe('400')
      }
    })

    it('colours the trail segments `--color-text-caption`, per theme', async () => {
      const light = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--light body--cobalt'
      })
      const dark = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--dark body--cobalt'
      })

      // #5a6699
      expect(light.trailSegment.color).toBe('rgb(90, 102, 153)')
      // #8b98d6
      expect(dark.trailSegment.color).toBe('rgb(139, 152, 214)')
    })

    it('colours the current segment `--color-accent-strong`, per theme', async () => {
      const light = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--light body--cobalt'
      })
      const dark = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--dark body--cobalt'
      })

      // #1f4fd6
      expect(light.current.color).toBe('rgb(31, 79, 214)')
      // #7fa0ff
      expect(dark.current.color).toBe('rgb(127, 160, 255)')
    })

    it('colours the separator distinctly from the trail segments, per theme', async () => {
      const light = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--light body--cobalt'
      })
      const dark = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--dark body--cobalt'
      })

      // #b6bfe0
      expect(light.separator.color).toBe('rgb(182, 191, 224)')
      // #3a4680
      expect(dark.separator.color).toBe('rgb(58, 70, 128)')
      expect(light.separator.color).not.toBe(light.trailSegment.color)
      expect(dark.separator.color).not.toBe(dark.trailSegment.color)
    })

    it('colours the "Last modified" note `--color-text-caption`, matching the trail segments', async () => {
      const light = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--light body--cobalt'
      })
      const dark = await measureBreadcrumbs({
        browser,
        css,
        html,
        bodyClasses: 'body--dark body--cobalt'
      })

      expect(light.modified.color).toBe(light.trailSegment.color)
      expect(dark.modified.color).toBe(dark.trailSegment.color)
    })
  }
)
