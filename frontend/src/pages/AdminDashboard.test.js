import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import AdminDashboard from '@/pages/AdminDashboard.vue'
import { chromium, hasChromium, buildAppCss } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'
import { seedAdmin, seedSite, seedUser } from '../../test/fixtures.js'

/*
  Every destination a card's footer button links to. Registered so the router resolves them: an
  unmatched `to` logs a warning per button and renders the anchor without an `href`, which changes
  nothing about the box being measured but buries the run in router noise.
*/
const CARD_ROUTES = [
  '/',
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

function mountDashboard() {
  stubApi(
    {
      'users/recent-logins': [
        { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', lastLoginAt: null }
      ]
    },
    { fallback: [] }
  )

  return mountWithApp(AdminDashboard, {
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
          currentVersion: '3.0.0'
        },
        versionStatus: 'latest'
      }),
      site: seedSite(),
      user: seedUser({ permissions: ['manage:system'] })
    }
  }).wrapper
}

/*
  The grid rule under test lives in `AdminDashboard.vue`'s own (unscoped) `<style lang="scss">`
  block, which `buildAppCss()` knows nothing about -- that compiles `src/css/tailwind.css` alone.
  Vitest's `css: true` does run every mounted SFC's style block through the real Sass/PostCSS
  pipeline and inject the result into the test document's `<head>`, so lifting those `<style>`
  elements out AFTER mounting is what gets the page's own rules in front of the browser. Measured
  without them, the cards are an unstyled stack of divs and the assertion below would pass while
  proving nothing.
*/
function mountedStyles() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

/**
 * Renders the dashboard's real markup at `containerWidth` in a headless Chromium page and reports
 * every direct child of `.admin-dashboard-grid`. Neither `jsdom` nor `happy-dom` runs a layout
 * engine (see `test/realGridLayout.js`), and "does a stretched grid item pass its height down to the
 * card inside it" is a pure layout question -- the exact class of defect PR #43 proved code review
 * and an emulated DOM both get wrong.
 */
async function measureGridChildren({ browser, html, css, containerWidth }) {
  const page = await browser.newPage()
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body style="margin:0"><div style="width:${containerWidth}px">${html}</div></body></html>`
    )
    return await page.evaluate(() => {
      const grid = document.querySelector('.admin-dashboard-grid')
      return [...grid.children].map((el) => {
        const rect = el.getBoundingClientRect()
        const card = el.classList.contains('w-card') ? el : el.querySelector('.w-card')
        const cardRect = card.getBoundingClientRect()
        return {
          label: el.querySelector('strong, .admin-dashboard-panel span')?.textContent.trim() ?? '',
          isLoginsPanel: el.classList.contains('admin-dashboard-logins'),
          /*
            Which of the two figure shapes this card carries. `<span>` is the 30px counter figure,
            `<small>` the 22px status line Logins and Wiki Version use -- the pair Dylan named, and
            the reason a card is short in the first place.
          */
          figureKind: el.querySelector('.admin-dashboard-card small')
            ? 'small'
            : el.querySelector('.admin-dashboard-card span')
              ? 'counter'
              : null,
          y: Math.round(rect.y),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          cardHeight: Math.round(cardRect.height),
          /*
            Where the footer strip sits relative to the card's own bottom content edge (the card
            draws a 1px hairline all the way round, which is outside everything it contains). A card
            that merely grew, without its body band absorbing the extra height, leaves the strip
            stranded mid-box -- which looks no better than the short card it replaced.
          */
          actionsGapFromBottom: (() => {
            const actions = card.querySelector('.w-card-actions')
            if (!actions) {
              return null
            }
            const border = Number.parseFloat(getComputedStyle(card).borderBottomWidth) || 0
            return Math.round(cardRect.bottom - border - actions.getBoundingClientRect().bottom)
          })()
        }
      })
    })
  } finally {
    await page.close()
  }
}

function rowsOf(items) {
  const byY = new Map()
  for (const item of items) {
    if (!byY.has(item.y)) {
      byY.set(item.y, [])
    }
    byY.get(item.y).push(item)
  }
  return [...byY.entries()].sort(([a], [b]) => a - b).map(([, row]) => row)
}

/*
  Chromium's launch, plus `buildAppCss()`'s full Tailwind compile, are both paid for once here while
  the rest of the suite's files are transforming across eight workers -- the same reason
  `ApiKeyCreateDialog.test.js`'s real-layout describe raises its timeout well past the 5s default.
*/
describe(
  'AdminDashboard counter grid — real layout',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let measured = null

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    /*
      Measured once, lazily, from inside a test rather than in `beforeAll`: `test/setup.js` rebuilds
      the `API_CLIENT` stub in a `beforeEach`, which has not run yet while a `beforeAll` body is
      executing, so mounting there throws before the dashboard's own `loadLastLogins()` can be
      stubbed at all.
    */
    async function items() {
      if (!measured) {
        const wrapper = mountDashboard()
        await new Promise((resolve) => setTimeout(resolve, 0))
        const html = wrapper.find('.admin-dashboard').html()
        const css = (await buildAppCss()) + mountedStyles()

        /*
          1200px is a routine desktop admin width, and it is what makes the assertion mean
          something: less the grid's own 24px side padding, `repeat(auto-fit, minmax(230px, 1fr))`
          with a 12px gap resolves to four columns, so a measured row mixes both card shapes -- the
          `<span>` counters (30px figure) alongside a `<small>` one (22px). A row of a single shape
          would report equal heights whether the card stretched or not, which is what the
          "not free" test below stands guard over.
        */
        measured = await measureGridChildren({ browser, html, css, containerWidth: 1200 })
        wrapper.unmount()
      }
      return measured
    }

    it('renders the nine counter cards plus the logins panel', async () => {
      const grid = await items()
      expect(grid).toHaveLength(10)
      expect(grid.filter((item) => item.isLoginsPanel)).toHaveLength(1)
    })

    it('gives every counter card in a row the same height', async () => {
      const grid = await items()
      /*
        Nine counters over a four-column track leaves a one-card final row, which is trivially the
        same height as itself -- the assertion is about the rows that actually hold a comparison.
      */
      const rows = rowsOf(grid.filter((item) => !item.isLoginsPanel)).filter(
        (row) => row.length > 1
      )
      expect(rows.length).toBeGreaterThan(1)

      for (const row of rows) {
        expect(new Set(row.map((item) => item.cardHeight)).size).toBe(1)
      }
    })

    it('mixes both figure sizes within a measured row, so the equality is not free', async () => {
      const counterRows = rowsOf((await items()).filter((item) => !item.isLoginsPanel))
      const mixed = counterRows.filter(
        (row) => new Set(row.map((item) => item.figureKind)).size > 1
      )
      expect(mixed.length).toBeGreaterThan(0)
    })

    it('fills the grid item with the card rather than a wrapper around it', async () => {
      for (const item of (await items()).filter((entry) => !entry.isLoginsPanel)) {
        expect(item.cardHeight).toBe(item.height)
      }
    })

    it('keeps each footer strip welded to its card bottom edge', async () => {
      for (const item of (await items()).filter((entry) => !entry.isLoginsPanel)) {
        expect(item.actionsGapFromBottom).toBe(0)
      }
    })

    /*
      The recent-logins panel is a reading panel, not a counter: `grid-column: 1 / -1` puts it on a
      row of its own and `max-width: 640px` caps it at a readable measure. Stretching the counters
      must not drag it to their height or widen it.
    */
    it('leaves the recent-logins panel on its own row, capped at its reading measure', async () => {
      const grid = await items()
      const panel = grid.find((item) => item.isLoginsPanel)
      const sharingItsRow = grid.filter((item) => item.y === panel.y)

      expect(sharingItsRow).toHaveLength(1)
      expect(panel.width).toBeLessThanOrEqual(640)
      expect(panel.height).not.toBe(grid.find((item) => !item.isLoginsPanel).height)
    })
  }
)
