import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileApi from './ProfileApi.vue'
import ProfileAuth from './ProfileAuth.vue'
import ProfileAvatar from './ProfileAvatar.vue'
import ProfileGroups from './ProfileGroups.vue'
import ProfileNotifications from './ProfileNotifications.vue'

import { mountWithApp } from '../../test/mount.js'
import { createApiClientStub, stubApi } from '../../test/mocks.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * What these five pages claim is a RHYTHM -- every row the same height, every plate the same 34px
 * at the same inset, every control on the same trailing edge, the rule between rows rather than
 * after the last one -- and `happy-dom` runs no layout engine, reporting every rect as zero. So
 * each page's real markup is rendered and measured in real headless Chromium;
 * `components/shared/WSettingsRow.layout.test.js` does the same against the row in isolation.
 *
 * `hasChromium()` skips the suite where `npm run install-browsers` has not been run -- a skipped
 * run has measured none of this.
 */

/**
 * The content column inside the profile overlay, near enough: the panel is about half the viewport
 * and gives 300px of that to the section rail (`ProfileOverlay.vue`). Pinned so the rhythm is
 * asserted at a width these pages are actually read at, not a full-page one they never see.
 */
const PANE_WIDTH = 560

/** 12px top + 34px plate + 12px bottom -- the plate is the tallest thing in a one-line row. */
const ONE_LINE_ROW_HEIGHT = 58

/** The card's own inline padding: both the plate's leading edge and the control's trailing edge
 *  land on it. */
const ROW_INLINE_PADDING = 14

function collectMountedStyles() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

const MESSAGES = {
  common: {
    actions: {
      clear: 'Clear',
      delete: 'Delete',
      refresh: 'Refresh',
      saveChanges: 'Save Changes'
    }
  },
  profile: {
    api: {
      createdOn: 'Created on {date}',
      expiresOn: 'Expires on {date}',
      keyEndingIn: 'Ending in {suffix}',
      keySite: 'Site: {site}',
      listTitle: 'Access Tokens',
      newKeyButton: 'New Personal Access Token',
      newKeyFullAccess: 'Full access',
      none: 'No tokens yet.',
      revoke: 'Revoke',
      subtitle: 'Personal access tokens',
      title: 'API Access'
    },
    auth: 'Authentication',
    authActions: 'Authentication options',
    authInfo: 'Your account is associated with the following authentication methods:',
    avatar: 'Avatar',
    avatarUploadHint: 'For best results, use a 180x180 image.',
    avatarUploadTitle: 'Upload your user profile picture.',
    groups: 'Groups',
    groupsInfo: "You're currently part of the following groups:",
    groupsMemberOf: 'Member Of',
    groupsNone: "You're not part of any group.",
    notifications: 'Notifications',
    notificationsGroupAccount: 'Account activity',
    notificationsGroupApprovals: 'Approvals',
    notificationsGroupAssets: 'Assets',
    notificationsGroupComments: 'Comments',
    notificationsGroupPages: 'Pages',
    notificationsSubtitle: 'Choose which events send you an email.',
    otherGroups: "You're not part of these other {siteName} groups:",
    otherGroupsTitle: 'Other Groups',
    passkeys: 'Passkeys',
    passkeysAdd: 'Add Passkey',
    passkeysIntro: 'Passkeys replace passwords.',
    uploadNewAvatar: 'Upload New Image'
  }
}

/**
 * `oneLineRows` says whether every row on that page is a single line of text, or whether some carry
 * a multi-line hint by design (Auth's status lines, Api's caption stack, Avatar's stacked preview)
 * -- the equal-height assertion only holds for the former.
 */
const PAGES = [
  {
    name: 'ProfileGroups',
    oneLineRows: true,
    mount: () => {
      stubApi({
        'users/profile/groups': {
          groups: [
            { id: 'g1', name: 'Editors' },
            { id: 'g2', name: 'Reviewers' }
          ],
          otherGroups: [{ id: 'g3', name: 'Administrators' }]
        }
      })
      return mountWithApp(ProfileGroups, {
        messages: MESSAGES,
        stores: { site: { title: 'Acme Wiki' } }
      })
    }
  },
  {
    name: 'ProfileNotifications',
    oneLineRows: true,
    mount: () => {
      stubApi({ 'users/profile/notifications': {} })
      return mountWithApp(ProfileNotifications, { messages: MESSAGES })
    }
  },
  {
    name: 'ProfileAvatar',
    oneLineRows: false,
    mount: () =>
      mountWithApp(ProfileAvatar, {
        messages: MESSAGES,
        stores: {
          site: (store) => {
            store.features = { profile: true }
          },
          user: { hasAvatar: false, name: 'Ada Lovelace' }
        }
      })
  },
  {
    name: 'ProfileAuth',
    oneLineRows: false,
    mount: () => {
      stubApi({
        'users/profile/auth': {
          authMethods: [
            {
              id: 'a1',
              authId: 'auth-local',
              authName: 'Local',
              strategyKey: 'local',
              strategyIcon: 'local.svg',
              config: {
                isPasswordSet: true,
                isTfaSetup: false,
                isPasswordLoginEnabled: true,
                canDisablePasswordLogin: true
              }
            }
          ],
          passkeys: [
            {
              id: 'p1',
              name: 'Yubikey',
              siteHostname: 'wiki.example',
              createdAt: '2026-01-02T03:04:05.000Z'
            }
          ]
        }
      })
      return mountWithApp(ProfileAuth, { messages: MESSAGES })
    }
  },
  {
    name: 'ProfileApi',
    oneLineRows: false,
    mount: () => {
      stubApi({
        'users/profile/api-keys': [
          {
            id: 'k1',
            name: 'CI robot',
            keyShort: 'a1b2',
            scope: null,
            allowedClassifications: null,
            siteId: null,
            isRevoked: false,
            // -> Real timestamps, not nulls: `helpers/apiKeyState.js` runs the expiration through
            //    `Temporal.Instant.from()`, which throws on one.
            createdAt: '2026-01-02T03:04:05.000Z',
            expiration: '2027-01-02T03:04:05.000Z'
          }
        ],
        sites: [],
        'classification-levels': []
      })
      return mountWithApp(ProfileApi, { messages: MESSAGES })
    }
  }
]

/** Everything measured off one rendered page, in a single `page.evaluate` round trip. */
function readPage() {
  const read = (el) => {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      borderTopWidth: Number.parseFloat(style.borderTopWidth),
      borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
      borderTopColor: style.borderTopColor,
      backgroundColor: style.backgroundColor,
      fontFamily: style.fontFamily,
      textTransform: style.textTransform
    }
  }
  return {
    headings: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((el) => ({
      tag: el.tagName,
      text: el.textContent.trim(),
      isCardHeader: el.classList.contains('w-settings-card__header')
    })),
    cards: [...document.querySelectorAll('.w-settings-card')].map((card) => ({
      ...read(card),
      header: read(card.querySelector('.w-settings-card__header')),
      rows: [...card.querySelectorAll('.w-settings-row')].map((row) => ({
        ...read(row),
        label: row.querySelector('.w-settings-row__label').textContent.trim(),
        plate: read(row.querySelector('.blueprint-icon')),
        text: read(row.querySelector('.w-settings-row__text')),
        control: read(row.querySelector('.w-settings-row__control')),
        preview: row.querySelector('.w-settings-row__preview')
          ? read(row.querySelector('.w-settings-row__preview'))
          : null
      }))
    }))
  }
}

describe(
  'profile sections: the settings rhythm, in a real browser',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    /** @type {Record<string, ReturnType<typeof readPage>>} */
    let measured

    /**
     * Memoized rather than a `beforeAll`: `test/setup.js` rebuilds `API_CLIENT`, `EVENT_BUS` and
     * `localStorage` in a `beforeEach`, and a `beforeAll` runs ahead of the first of those --
     * mounting there dies on `WBtn`'s `EVENT_BUS.on(...)`. Awaited at the top of each test instead,
     * where the harness's globals are in place. `createApiClientStub()` per page on top of that
     * keeps one page's stubbed responses from answering the next page's request.
     */
    let measuring = null

    function measureAll() {
      measuring ??= (async () => {
        const appCss = await buildAppCss()
        const results = {}

        for (const { name, mount } of PAGES) {
          globalThis.API_CLIENT = createApiClientStub()
          const { wrapper } = mount()
          await flushPromises()
          const html = wrapper.html()
          const scopedCss = collectMountedStyles()

          // -> Without the scoped CSS there is no plate, no padding and no rule, and every number
          //    below would be measuring a bare DOM.
          expect(scopedCss, `${name} scoped CSS`).toContain('w-settings-row')

          const page = await browser.newPage()
          try {
            await page.setContent(
              `<!doctype html><html><head><style>${appCss}</style><style>${scopedCss}</style></head>` +
                `<body style="margin:0"><div style="width:${PANE_WIDTH}px">${html}</div></body></html>`
            )
            results[name] = await page.evaluate(readPage)
          } finally {
            await page.close()
          }
          wrapper.unmount()
        }
        return results
      })()
      return measuring
    }

    beforeAll(async () => {
      browser = await chromium.launch()
    }, 60000)

    afterAll(async () => {
      await browser?.close()
    })

    it('puts every one of the five onto settings cards', async () => {
      measured = await measureAll()

      for (const { name } of PAGES) {
        expect(measured[name].cards.length, `${name} cards`).toBeGreaterThan(0)
        for (const card of measured[name].cards) {
          expect(card.rows.length, `${name} card rows`).toBeGreaterThan(0)
        }
      }
    })

    it('keeps each page its own <h1> and gives every card a mono uppercase strip', async () => {
      measured = await measureAll()
      for (const { name } of PAGES) {
        const headings = measured[name].headings
        // -> The rendered half of `pages/pageTitleHeadings.test.js`'s source scan.
        expect(
          headings.filter((h) => h.tag === 'H1'),
          `${name} page title`
        ).toHaveLength(1)
        for (const card of measured[name].cards) {
          expect(card.header.textTransform).toBe('uppercase')
          expect(card.header.fontFamily.toLowerCase()).toContain('mono')
        }
        for (const heading of headings.filter((h) => h.isCardHeader)) {
          expect(heading.tag, `${name} card strip level`).toBe('H2')
        }
      }
    })

    it('draws the same 34px plate at the same inset on every row of all five', async () => {
      measured = await measureAll()
      for (const { name } of PAGES) {
        for (const card of measured[name].cards) {
          for (const row of card.rows) {
            expect(row.plate.width, `${name} plate on "${row.label}"`).toBe(34)
            expect(row.plate.height, `${name} plate on "${row.label}"`).toBe(34)
            expect(row.plate.left - row.left, `${name} inset on "${row.label}"`).toBe(
              ROW_INLINE_PADDING
            )
            expect(row.text.left - row.plate.right, `${name} gap on "${row.label}"`).toBe(14)
          }
        }
      }
    })

    it('holds one row height across every row of the two pages that are one line each', async () => {
      measured = await measureAll()
      for (const { name, oneLineRows } of PAGES.filter((page) => page.oneLineRows)) {
        expect(oneLineRows).toBe(true)
        const heights = new Set()
        for (const card of measured[name].cards) {
          for (const row of card.rows) {
            // -> Minus the rule, which every row but the first of its card also carries in its border box.
            const height = row.height - row.borderTopWidth
            expect(height, `${name} row "${row.label}"`).toBe(ONE_LINE_ROW_HEIGHT)
            heights.add(height)
          }
        }
        expect(heights.size, `${name} distinct row heights`).toBe(1)
      }
    })

    it('lands every control on the same trailing edge, on all five', async () => {
      measured = await measureAll()
      for (const { name } of PAGES) {
        for (const card of measured[name].cards) {
          // -> `- 1` for the card's own hairline edge, which the row sits inside.
          const trailingEdge = card.right - 1 - ROW_INLINE_PADDING
          for (const row of card.rows) {
            expect(row.control.right, `${name} trailing edge of "${row.label}"`).toBeCloseTo(
              trailingEdge,
              1
            )
          }
        }
      }
    })

    it('rules BETWEEN rows on every card: none above the first, one above each of the rest, none below', async () => {
      measured = await measureAll()
      for (const { name } of PAGES) {
        for (const card of measured[name].cards) {
          const [first, ...rest] = card.rows
          expect(first.borderTopWidth, `${name} rule above the first row`).toBe(0)
          for (const row of rest) {
            expect(row.borderTopWidth, `${name} rule above "${row.label}"`).toBe(1)
          }
          for (const row of card.rows) {
            expect(row.borderBottomWidth, `${name} rule below "${row.label}"`).toBe(0)
          }
        }
      }
    })

    it('stacks the rows straight under the strip, edge to edge inside the card', async () => {
      measured = await measureAll()
      for (const { name } of PAGES) {
        for (const card of measured[name].cards) {
          expect(card.rows[0].top, `${name} first row under the strip`).toBeCloseTo(
            card.header.bottom,
            1
          )
          for (let i = 1; i < card.rows.length; i += 1) {
            expect(card.rows[i].top, `${name} row ${i}`).toBeCloseTo(card.rows[i - 1].bottom, 1)
          }
          for (const row of card.rows) {
            expect(row.left).toBeCloseTo(card.left + 1, 1)
            expect(row.right).toBeCloseTo(card.right - 1, 1)
          }
        }
      }
    })

    /**
     * The one stacked case among the five: it reuses the shared row's existing preview slot rather
     * than a second variant, positioned as Admin General's logo row is -- under both halves of the
     * row, clear of the plate.
     */
    it('stacks the avatar preview under the row rather than beside it', async () => {
      measured = await measureAll()
      const [card] = measured.ProfileAvatar.cards
      const [row] = card.rows

      expect(row.preview).not.toBeNull()
      expect(row.preview.top).toBeGreaterThanOrEqual(row.text.bottom)
      expect(row.preview.top).toBeGreaterThanOrEqual(row.control.bottom)
      expect(row.preview.left).toBeCloseTo(row.text.left, 1)
      expect(row.preview.left).toBeGreaterThan(row.plate.right)
      // -> A real 180px avatar, not an empty slot that happens to satisfy the geometry above
      expect(row.preview.height).toBeGreaterThanOrEqual(180)
    })
  }
)
