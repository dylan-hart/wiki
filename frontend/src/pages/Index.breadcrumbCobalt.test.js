import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import WBreadcrumbs from '@/components/shared/WBreadcrumbs.vue'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * `WBreadcrumbs.vue` renders its `active-color`/`separator-color` props as literal inline `color`
 * styles -- Ledger greys, whatever the aesthetic -- and an inline style outranks the
 * `.page-breadcrumbs` stylesheet rule for every crumb but the last.
 *
 * A real browser, because resolving a custom property through the cascade, and inline-versus-
 * stylesheet priority, is exactly what the DOM emulators do not do.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> Nothing to compile: every SFC `<style>` block is already plain, valid CSS, native nesting
  //    included, which the real Chromium below parses as-is
  return sfcStyles(relativePath)
}

/**
 * The band as `Index.vue` renders it, down to the props the page passes. The "Last modified" note
 * sits in the same band under an unscoped colour rule, so it is measured from the same fixture.
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
