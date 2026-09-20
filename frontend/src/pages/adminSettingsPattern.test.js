import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * A source scan rather than a mount per page: which component a page's cards are is a static
 * property of its markup, and mounting each one (store, router, API fixtures) to read a tag name is
 * a great deal of fixture weight for it. What the rows actually MEASURE lives in
 * `components/shared/WSettingsRow.layout.test.js`, which renders them in real headless Chromium.
 *
 * The list is written out rather than globbed: a glob over `Admin*.vue` would silently pull in the
 * list/viewer/tool pages, which are not settings forms at all.
 */
const SETTINGS_PAGES = [
  'AdminAnalytics',
  'AdminApi',
  'AdminApprovals',
  'AdminAuth',
  'AdminComments',
  'AdminEditors',
  'AdminFlags',
  'AdminGlossary',
  'AdminLocale',
  'AdminLogin',
  'AdminMail',
  'AdminMetrics',
  'AdminNavigation',
  'AdminPagesDeleted',
  'AdminPageviews',
  'AdminReplication',
  'AdminSearch',
  'AdminSecurity',
  'AdminStorage',
  'AdminSystem',
  'AdminTheme'
]

/**
 * These adopt `useAdminSettings` but have no settings ROW: their one setting is a page-header
 * on/off button and what they load is a report. A card strip naming nothing, over a row with no
 * control, would read worse than leaving them unconverted.
 */
const NO_SETTINGS_ROWS = ['AdminMetrics', 'AdminPageviews', 'AdminPagesDeleted']

const pagesDir = dirname(fileURLToPath(import.meta.url))

function sourceOf(name) {
  return readFileSync(join(pagesDir, `${name}.vue`), 'utf-8')
}

describe('the admin settings pages all draw the shared settings pattern (Wiki #2700)', () => {
  it('names 21 pages, which is the Task resolved scope', () => {
    expect(SETTINGS_PAGES).toHaveLength(21)
    // -> An existence check, so a rename cannot retire one of these guards silently.
    for (const name of SETTINGS_PAGES) {
      expect(() => sourceOf(name), name).not.toThrow()
    }
  })

  it('leaves no <w-card-header> on any of them', () => {
    const offenders = SETTINGS_PAGES.filter((name) => sourceOf(name).includes('<w-card-header'))

    expect(offenders).toEqual([])
  })

  it('leaves no hand-written .w-section-header band on any of them', () => {
    const offenders = SETTINGS_PAGES.filter((name) =>
      /class="[^"]*\bw-section-header\b/.test(sourceOf(name))
    )

    expect(offenders).toEqual([])
  })

  /**
   * `ModuleConfigForm` counts: it emits one `WSettingsRow` per prop of a module's config, so a card
   * whose whole body is one has rows -- declared in the shared component rather than in the page.
   */
  it('gives every page that has a settings card at least one settings row in it', () => {
    const offenders = SETTINGS_PAGES.filter((name) => {
      const source = sourceOf(name)
      return (
        source.includes('<w-settings-card') &&
        !source.includes('<w-settings-row') &&
        !source.includes('<module-config-form')
      )
    })

    expect(offenders).toEqual([])
  })

  it('converts every page except the three with no setting to draw', () => {
    const unconverted = SETTINGS_PAGES.filter(
      (name) => !sourceOf(name).includes('<w-settings-card')
    )

    expect(unconverted.toSorted()).toEqual(NO_SETTINGS_ROWS.toSorted())
  })

  /**
   * `WItem` alone stays legitimate for a LIST (the auth strategy rail, the storage target picker),
   * so the assertion is narrower: a `BlueprintIcon` inside a `WItem` is the hand-written settings
   * row and nothing else.
   */
  it('leaves no hand-written settings row (a BlueprintIcon inside a WItem) on any of them', () => {
    const offenders = SETTINGS_PAGES.filter((name) =>
      /<w-item[\s>][\s\S]{0,400}?<blueprint-icon/.test(sourceOf(name))
    )

    expect(offenders).toEqual([])
  })
})
