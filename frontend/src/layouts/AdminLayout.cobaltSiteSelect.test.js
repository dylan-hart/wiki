import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminLayout from './AdminLayout.vue'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'
import { createTestRouter } from '../../test/router.js'

/**
 * OpenProject #3002 ("Cobalt admin Site dropdown missing darker interior, lighter blue border,
 * taller control, more padding"). Real-browser, same technique as
 * `AdminLayout.cobaltTypography.test.js`: neither `jsdom` nor `happy-dom` resolves an unscoped SFC
 * `<style>` block against the compiled `--color-*` chain the way a real engine does, and `WSelect`'s
 * `standout`/`dense` sizing comes from Tailwind utility classes this rule has to actually beat with
 * `!important` -- the only way to know that happened is to ask a real browser to compute it.
 */

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
})

function mountedStyles() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

async function mountLayoutHtml() {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'sites') {
      return { json: () => Promise.resolve([{ id: 'site1', title: 'Site 1' }]) }
    }
    if (typeof url === 'string' && url.endsWith('/userPermissions')) {
      return { json: () => Promise.resolve([]) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  const router = await createTestRouter(['/_admin/:siteid/general'], '/_admin/site1/general')
  const { wrapper } = mountWithApp(AdminLayout, {
    router,
    stores: { user: { permissions: ['access:admin', 'manage:sites'] } }
  })
  await flushPromises()
  const html = wrapper.find('.admin').html()
  wrapper.unmount()
  return html
}

describe(
  'Admin Cobalt Site dropdown (AdminLayout.vue) — real browser',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let fragments = null

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    async function getFragments() {
      if (!fragments) {
        const layoutHtml = await mountLayoutHtml()
        const css = (await buildAppCss()) + mountedStyles()
        fragments = { layoutHtml, css }
      }
      return fragments
    }

    async function measure({ cobalt = false, dark = false } = {}) {
      const { layoutHtml, css } = await getFragments()
      const page = await browser.newPage()
      try {
        const bodyClass = [cobalt && 'body--cobalt', dark ? 'body--dark' : 'body--light']
          .filter(Boolean)
          .join(' ')
        const rootStyle = cobalt ? ' style="--q-accent:#c8303c;--q-positive:#177a5e"' : ''
        await page.setContent(
          `<!doctype html><html${rootStyle}><head><style>${css}</style></head>` +
            `<body class="${bodyClass}">${layoutHtml}</body></html>`
        )
        return await page.evaluate(() => {
          const el = document.querySelector('.admin-site-select .w-input-control')
          if (!el) {
            throw new Error('selector not found: .admin-site-select .w-input-control')
          }
          const s = getComputedStyle(el)
          return {
            minHeight: s.minHeight,
            paddingInlineStart: s.paddingInlineStart,
            paddingInlineEnd: s.paddingInlineEnd,
            backgroundColor: s.backgroundColor,
            borderTopWidth: s.borderTopWidth,
            borderTopColor: s.borderTopColor,
            borderTopStyle: s.borderTopStyle
          }
        })
      } finally {
        await page.close()
      }
    }

    it('draws a 38px-tall, 14px-padded control with a dark-4 interior and h2-blue border — Cobalt light', async () => {
      const style = await measure({ cobalt: true, dark: false })
      expect(style.minHeight).toBe('38px')
      expect(style.paddingInlineStart).toBe('14px')
      expect(style.paddingInlineEnd).toBe('14px')
      expect(style.backgroundColor).toBe('rgb(23, 27, 36)') // --color-dark-4, #171b24
      expect(style.borderTopWidth).toBe('1px')
      expect(style.borderTopStyle).toBe('solid')
      expect(style.borderTopColor).toBe('rgb(31, 79, 214)') // --color-heading-h2, #1f4fd6
    })

    it('draws the same 38px/14px sizing with a deeper interior and a lighter blue border — Cobalt dark', async () => {
      const style = await measure({ cobalt: true, dark: true })
      expect(style.minHeight).toBe('38px')
      expect(style.paddingInlineStart).toBe('14px')
      expect(style.paddingInlineEnd).toBe('14px')
      expect(style.backgroundColor).toBe('rgb(7, 11, 34)') // --color-dark-4 under Cobalt dark, #070b22
      expect(style.borderTopWidth).toBe('1px')
      expect(style.borderTopStyle).toBe('solid')
      expect(style.borderTopColor).toBe('rgb(143, 176, 255)') // --color-heading-h2 under Cobalt dark, #8fb0ff
    })

    it('leaves the Ledger control at its generic dense/standout sizing, no border', async () => {
      const style = await measure({ cobalt: false, dark: false })
      expect(style.minHeight).toBe('28px') // dense's min-h-7
      expect(style.borderTopWidth).toBe('0px')
    })
  }
)

/**
 * Source-text check for the class wiring and the Cobalt rule's shape, mirroring
 * `AdminLayout.cobaltTypography.test.js`'s bottom describe -- runs with no Chromium available too.
 */
describe('.admin-site-select wiring', () => {
  const source = readFileSync(join(import.meta.dirname, 'AdminLayout.vue'), 'utf-8')

  it('the Site w-select carries the admin-site-select class', () => {
    const selectStart = source.indexOf('v-model="adminStore.currentSiteId"')
    expect(selectStart).toBeGreaterThan(-1)
    const tagStart = source.lastIndexOf('<w-select', selectStart)
    const tagEnd = source.indexOf('/>', selectStart)
    const tag = source.slice(tagStart, tagEnd)
    expect(tag).toContain('class="admin-site-select"')
  })

  it('the Cobalt rule lives inside .admin-sidebar, not the shared header/eyebrow area', () => {
    const cobaltBlockStart = source.indexOf('body.body--cobalt {')
    const sidebarStart = source.indexOf('.admin-sidebar {', cobaltBlockStart)
    const ruleStart = source.indexOf('.admin-site-select .w-input-control {', cobaltBlockStart)
    expect(cobaltBlockStart).toBeGreaterThan(-1)
    expect(sidebarStart).toBeGreaterThan(cobaltBlockStart)
    expect(ruleStart).toBeGreaterThan(sidebarStart)
  })

  it('the rule sets height, padding, fill and border — the four reported gaps', () => {
    const ruleStart = source.indexOf('.admin-site-select .w-input-control {')
    const ruleEnd = source.indexOf('}', ruleStart)
    const rule = source.slice(ruleStart, ruleEnd)
    expect(rule).toMatch(/min-height:\s*38px\s*!important/)
    expect(rule).toMatch(/padding-inline:\s*14px\s*!important/)
    expect(rule).toMatch(/background-color:\s*var\(--color-dark-4\)\s*!important/)
    expect(rule).toMatch(/border:\s*1px solid var\(--color-heading-h2\)/)
  })
})
