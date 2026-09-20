import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import AdminDashboard from '@/pages/AdminDashboard.vue'
import { chromium, hasChromium, buildAppCss } from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'
import { seedAdmin, seedSite, seedUser } from '../../test/fixtures.js'

/*
  Registered so the router resolves every card's `to`: an unmatched one logs a warning per button and
  buries the run in router noise.
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

function mountDashboard({ permissions = ['manage:system'] } = {}) {
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
      user: seedUser({ permissions })
    }
  }).wrapper
}

/*
  The button carries no test id, so it is found by its label text: no `messages` are seeded, so
  `t('admin.analytics.title')` resolves to the key itself, which is still unique on this page.
*/
function findAnalyticsButton(wrapper) {
  return wrapper.findAll('a, button').find((el) => el.text().includes('admin.analytics.title'))
}

describe('AdminDashboard Analytics button', () => {
  it('is disabled for a user without manage:sites, like its sibling admin buttons', () => {
    const wrapper = mountDashboard({ permissions: [] })
    const analyticsBtn = findAnalyticsButton(wrapper)

    expect(analyticsBtn).not.toBeUndefined()
    expect(analyticsBtn.attributes('aria-disabled')).toBe('true')
  })

  it('is enabled for a user with manage:sites', () => {
    const wrapper = mountDashboard({ permissions: ['manage:sites'] })
    const analyticsBtn = findAnalyticsButton(wrapper)

    expect(analyticsBtn).not.toBeUndefined()
    expect(analyticsBtn.attributes('aria-disabled')).toBeUndefined()
  })
})

/*
  The grid rule under test lives in `AdminDashboard.vue`'s own `<style>` block, which `buildAppCss()`
  knows nothing about -- it compiles `src/css/tailwind.css` alone. Vitest's `css: true` injects a
  mounted SFC's style block into the test document, so lifting those `<style>` elements out AFTER
  mounting is what gets the page's own rules in front of the browser.
*/
function mountedStyles() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

/**
 * Real Chromium: neither `jsdom` nor `happy-dom` runs a layout engine, and "does a stretched grid
 * item pass its height down to the card inside it" is a pure layout question.
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
          /* `<span>` is the counter figure; `<small>` is the smaller one Logins and Version use. */
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
            Distance from the footer strip to the card's bottom content edge; the hairline border
            sits outside everything the card contains, so it is subtracted. A card that grew without
            its body band absorbing the extra height leaves the strip stranded mid-box.
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
  Chromium's launch and `buildAppCss()`'s full Tailwind compile are both paid for here, which is why
  the timeout sits well past the 5s default.
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
      Measured lazily from inside a test rather than in `beforeAll`: `test/setup.js` rebuilds the
      `API_CLIENT` stub in a `beforeEach`, which has not run while a `beforeAll` body executes, so
      mounting there throws before `loadLastLogins()` can be stubbed at all.
    */
    async function items() {
      if (!measured) {
        const wrapper = mountDashboard()
        await new Promise((resolve) => setTimeout(resolve, 0))
        const html = wrapper.find('.admin-dashboard').html()
        const css = (await buildAppCss()) + mountedStyles()

        /*
          1200px is what makes the assertion mean something: the grid's `auto-fit`/`minmax()` track
          resolves to four columns at this width, so a measured row mixes both card shapes. A row of
          a single shape would report equal heights whether the card stretched or not.
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
        The final row holds a single card, trivially the same height as itself -- the assertion is
        about the rows that actually hold a comparison.
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
      A reading panel, not a counter: `grid-column: 1 / -1` puts it on a row of its own and
      `max-width` caps it at a readable measure. Stretching the counters must not disturb either.
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
