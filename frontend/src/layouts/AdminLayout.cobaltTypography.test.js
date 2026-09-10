import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminLayout from './AdminLayout.vue'
import AdminDashboard from '../pages/AdminDashboard.vue'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'
import { seedAdmin, seedSite, seedUser } from '../../test/fixtures.js'
import { createTestRouter } from '../../test/router.js'

/**
 * OpenProject #2983 ("Cobalt typography: admin (AdminLayout.vue, AdminDashboard.vue)"),
 * `ui-iteration-cobalt-typography/cobalt-typography.md` §3 "Admin" — the role table for these two
 * files. Real-browser, per §7's `measure()` pattern: neither `jsdom` nor `happy-dom` runs font
 * shaping or resolves a Vue SFC's own unscoped `<style>` block against the compiled `--color-*`
 * chain the way a real engine does, so the only way to know what a reader's browser actually
 * computes for these roles is to ask one.
 *
 * Reuses this workspace's own established real-Chromium machinery rather than inventing a second
 * one: `mountWithApp` + `buildAppCss()`/`mountedStyles()` is exactly `AdminDashboard.test.js`'s own
 * "AdminDashboard counter grid — real layout" describe's technique (there for bounding rects, here
 * for `getComputedStyle`), including that same file's reason for mounting lazily from inside the
 * first `it()` rather than from `beforeAll`: `test/setup.js` rebuilds the `API_CLIENT` stub in a
 * `beforeEach`, which has not run yet while `beforeAll` is still executing. The two-mount,
 * side-by-side-fragments trick below is what lets one Chromium page see both files' compiled CSS
 * (`AdminLayout.vue`'s unscoped block owns `.admin-area-label`/`.admin-nav-list`/`.admin-page-title`;
 * `AdminDashboard.vue`'s owns `.admin-dashboard-card`) without mounting the whole app shell.
 */

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
})

const CARD_ROUTES = [
  '/',
  '/_admin/dashboard',
  '/_admin/sites',
  '/_admin/groups',
  '/_admin/users',
  '/_admin/site-1/pages',
  '/_admin/site-1/analytics',
  '/_admin/system',
  '/_admin/scheduler',
  '/_admin/cluster',
  '/_admin/webhooks'
]

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

async function mountDashboardHtml() {
  stubApi({ 'users/recent-logins': [] }, { fallback: [] })

  const { wrapper } = mountWithApp(AdminDashboard, {
    routes: CARD_ROUTES,
    stores: {
      admin: seedAdmin({
        sites: [{ id: 'site-1' }],
        info: {
          groupsTotal: 4,
          usersTotal: 12,
          pagesTotal: 128,
          loginsPastDay: 3,
          activeWorkers: 2,
          clusterTotal: 1,
          webhooksTotal: 0,
          /*
            `versionStatus` is a GETTER derived from these two, not a settable field -- passing it
            directly (as `AdminDashboard.test.js`'s own seed does, for its layout-only assertions
            that never look at it) silently no-ops. `latestVersion` <= `currentVersion` is what
            actually drives `versionStatus` to `'latest'`, the one state this suite's "Status line"
            role needs.
          */
          currentVersion: '3.0.0',
          latestVersion: '3.0.0'
        }
      }),
      site: seedSite(),
      user: seedUser({ permissions: ['manage:system'] })
    }
  })
  await flushPromises()
  const html = wrapper.find('.admin-dashboard').html()
  wrapper.unmount()
  return html
}

describe(
  'Admin cobalt typography (AdminLayout.vue + AdminDashboard.vue) — real browser',
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

    /*
      Mounted lazily, once, from inside a test rather than `beforeAll` — see the file-header comment
      for why (the `API_CLIENT` stub `test/setup.js` rebuilds per-test does not exist yet while
      `beforeAll` is running).
    */
    async function getFragments() {
      if (!fragments) {
        // -> Both mounted before either's styles are read out, so `mountedStyles()` sees BOTH
        //    files' injected `<style>` tags cumulatively — Vite's SFC style injection under
        //    `css: true` is per-module and additive, not per-mount.
        const layoutHtml = await mountLayoutHtml()
        const dashboardHtml = await mountDashboardHtml()
        const css = (await buildAppCss()) + mountedStyles()
        fragments = { layoutHtml, dashboardHtml, css }
      }
      return fragments
    }

    async function measure({ cobalt = false } = {}) {
      const { layoutHtml, dashboardHtml, css } = await getFragments()
      const page = await browser.newPage()
      try {
        const bodyClass = cobalt ? 'body--cobalt' : ''
        /*
          `--q-accent`/`--q-positive` are NOT static tokens: `App.vue#applyTheme()` writes them as
          inline custom properties on `document.documentElement` at runtime
          (`helpers/cssVars.js#setCssVar`), resolved per-aesthetic from
          `helpers/aestheticDefaults.js`. This synthetic page never boots `App.vue`, so it has to
          seed the same two values by hand for the Cobalt case or every `--color-accent`/
          `--color-positive` reader below would silently fall back to `tailwind.css`'s `:root`
          (Ledger) defaults despite `body--cobalt` being set.
        */
        const rootStyle = cobalt ? ' style="--q-accent:#c8303c;--q-positive:#177a5e"' : ''
        await page.setContent(
          `<!doctype html><html${rootStyle}><head><style>${css}</style></head>` +
            `<body class="${bodyClass}">${layoutHtml}${dashboardHtml}</body></html>`
        )
        return await page.evaluate(() => {
          const styleOf = (selector) => {
            const el = document.querySelector(selector)
            if (!el) {
              throw new Error(`selector not found: ${selector}`)
            }
            return getComputedStyle(el)
          }
          const read = (selector) => {
            const s = styleOf(selector)
            return {
              family: s.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
              size: s.fontSize,
              weight: s.fontWeight,
              lineHeight: s.lineHeight,
              tracking: s.letterSpacing,
              transform: s.textTransform,
              color: s.color
            }
          }
          return {
            adminKicker: read('.admin-area-label'),
            navItem: read('a[href="/_admin/dashboard"] .w-item-section--main'),
            pageTitle: read('.admin-page-title'),
            counterNumeral: read('.admin-dashboard-card span'),
            counterSmallNumeral: read('.admin-dashboard-card small:not(.admin-dashboard-status)'),
            counterCaption: read('.admin-dashboard-card small:not(.admin-dashboard-status) i'),
            statusLine: read('.admin-dashboard-status'),
            panelKicker: read('.admin-dashboard-panel span')
          }
        })
      } finally {
        await page.close()
      }
    }

    let cobaltLight
    let ledgerLight

    async function readings() {
      if (!cobaltLight) {
        cobaltLight = await measure({ cobalt: true })
        ledgerLight = await measure({ cobalt: false })
      }
      return { cobaltLight, ledgerLight }
    }

    it('draws the "Admin area" kicker as 600 10px mono, .24em uppercase, #e6ecff under Cobalt', async () => {
      const { adminKicker } = (await readings()).cobaltLight
      expect(adminKicker.family).toBe('Roboto Mono')
      expect(adminKicker.size).toBe('10px')
      expect(adminKicker.weight).toBe('600')
      expect(adminKicker.tracking).toBe('2.4px') // -> 0.24em of 10px
      expect(adminKicker.transform).toBe('uppercase')
      expect(adminKicker.color).toBe('rgb(230, 236, 255)') // #e6ecff
    })

    it('draws an admin nav item as 300 16px Barlow sans, in the admin sidebar text tone', async () => {
      const { navItem } = (await readings()).cobaltLight
      expect(navItem.family).toBe('Barlow')
      expect(navItem.size).toBe('16px')
      expect(navItem.weight).toBe('300')
      expect(navItem.color).toBe('rgb(197, 207, 245)') // --color-admin-sidebar-text, #c5cff5
    })

    it('keeps the admin nav item metric identical between Cobalt and Ledger — only colour differs', async () => {
      const { cobaltLight, ledgerLight } = await readings()
      expect(ledgerLight.navItem.family).toBe(cobaltLight.navItem.family)
      expect(ledgerLight.navItem.size).toBe(cobaltLight.navItem.size)
      expect(ledgerLight.navItem.weight).toBe(cobaltLight.navItem.weight)
      expect(ledgerLight.navItem.color).not.toBe(cobaltLight.navItem.color)
    })

    it('draws the dashboard page title as 700 34px/1.05 Barlow Condensed, in ink', async () => {
      const { pageTitle } = (await readings()).cobaltLight
      expect(pageTitle.family).toBe('Barlow Condensed')
      expect(pageTitle.size).toBe('34px')
      expect(pageTitle.weight).toBe('700')
      expect(pageTitle.color).toBe('rgb(16, 25, 74)') // --color-ink under Cobalt, #10194a
    })

    it('draws a counter numeral as 700 30px/1.1 display, in the accent', async () => {
      const { counterNumeral } = (await readings()).cobaltLight
      expect(counterNumeral.family).toBe('Barlow Condensed')
      expect(counterNumeral.size).toBe('30px')
      expect(counterNumeral.weight).toBe('700')
      expect(counterNumeral.color).toBe('rgb(200, 48, 60)') // Cobalt's admin accent default, #c8303c
    })

    it("draws the Logins card's counter small numeral as 700 26px/1.2 display, in the accent", async () => {
      const { counterSmallNumeral } = (await readings()).cobaltLight
      expect(counterSmallNumeral.family).toBe('Barlow Condensed')
      expect(counterSmallNumeral.size).toBe('26px')
      expect(counterSmallNumeral.weight).toBe('700')
      expect(counterSmallNumeral.color).toBe('rgb(200, 48, 60)')
    })

    it('draws its caption ("/ past 24h") as 400 12px Roboto Mono, in the caption tone', async () => {
      const { counterCaption } = (await readings()).cobaltLight
      expect(counterCaption.family).toBe('Roboto Mono')
      expect(counterCaption.size).toBe('12px')
      expect(counterCaption.weight).toBe('400')
      expect(counterCaption.color).toBe('rgb(90, 102, 153)') // --color-text-caption under Cobalt, #5a6699
    })

    it('draws the Wiki Version card\'s "Up to date!" status line as 500 14px/1.4 sans, in positive text', async () => {
      const { statusLine } = (await readings()).cobaltLight
      expect(statusLine.family).toBe('Barlow')
      expect(statusLine.size).toBe('14px')
      expect(statusLine.weight).toBe('500')
      expect(statusLine.lineHeight).toBe('19.6px') // 1.4 * 14px
      expect(statusLine.color).toBe('rgb(23, 122, 94)') // --color-positive under Cobalt, #177a5e
    })

    it('keeps the status line metric identical between Cobalt and Ledger — only colour differs', async () => {
      const { cobaltLight, ledgerLight } = await readings()
      expect(ledgerLight.statusLine.family).toBe(cobaltLight.statusLine.family)
      expect(ledgerLight.statusLine.size).toBe(cobaltLight.statusLine.size)
      expect(ledgerLight.statusLine.weight).toBe(cobaltLight.statusLine.weight)
      expect(ledgerLight.statusLine.color).not.toBe(cobaltLight.statusLine.color)
    })

    it('draws the "Last logins" panel kicker as 600 11px mono, .18em uppercase, in slate', async () => {
      const { panelKicker } = (await readings()).cobaltLight
      expect(panelKicker.family).toBe('Roboto Mono')
      expect(panelKicker.size).toBe('11px')
      expect(panelKicker.weight).toBe('600')
      expect(panelKicker.tracking).toBe('1.98px') // 0.18em of 11px
      expect(panelKicker.transform).toBe('uppercase')
      expect(panelKicker.color).toBe('rgb(30, 42, 94)') // --color-slate under Cobalt, #1e2a5e
    })
  }
)

/**
 * §2/§6 audit constraint: a Cobalt-scoped rule may change `color` and nothing else that affects
 * type. Source-text check (the established pattern for an unscoped SFC `<style>` block with no
 * compiled stylesheet to assert live values against — see `MainLayout.cobaltDialogCorners.test.js`)
 * over the one Cobalt-scoped rule this task touched.
 */
describe('Cobalt-scoped .admin-area-label rule carries no font-metric properties', () => {
  const source = readFileSync(join(import.meta.dirname, 'AdminLayout.vue'), 'utf-8')
  const cobaltBlockStart = source.indexOf('body.body--cobalt {')
  const ruleStart = source.indexOf('.admin-area-label {', cobaltBlockStart)
  const ruleEnd = source.indexOf('}', ruleStart)
  const rule = source.slice(ruleStart, ruleEnd)

  it('rule exists inside the Cobalt block', () => {
    expect(cobaltBlockStart).toBeGreaterThan(-1)
    expect(ruleStart).toBeGreaterThan(cobaltBlockStart)
  })

  it('sets only colour', () => {
    expect(rule).toMatch(/color:\s*#e6ecff/)
    expect(rule).not.toMatch(/font-size|font-weight|line-height|letter-spacing|text-transform/)
  })
})
