import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Wiki #2700: the 21 admin settings pages all draw their settings through `WSettingsCard` /
 * `WSettingsRow` now, so that the Cardinal settings treatment is stated once
 * (`components/shared/WSettingsCard.vue`) rather than hand-applied per page -- which is exactly the
 * drift `.w-section-header` accumulated before it was pulled into `WCardHeader`.
 *
 * A source scan rather than 21 mounts, on the same tradeoff `pageTitleHeadings.test.js` and
 * `docsBaseGate.test.js` make: which component a page's cards are is a static property of its
 * markup, and mounting every one of these (each with its own store, router and API fixtures) to
 * read a tag name would be a great deal of fixture weight for it. What the rows actually MEASURE is
 * a separate question and lives in `components/shared/WSettingsRow.layout.test.js`, which renders
 * them in real headless Chromium.
 *
 * The list is deliberately written out rather than derived from a glob. It is the Task's own
 * resolved scope -- the 19 `composables/adminSettings.js` adopters other than `AdminGeneral` (#2699's
 * reference conversion) and `AdminBlocks` (its own design, #2629), plus the two documented
 * `useAdminSettings` hold-outs -- and a glob over `Admin*.vue` would silently pull in the 13
 * list/viewer/tool pages that are #2702's and are not settings forms at all.
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
 * Three of the 21 adopt `useAdminSettings` but have no settings ROW on them: their one setting is a
 * page-header on/off button, and their body is banners, stat tiles or a table. `useAdminSettings`
 * was the right discriminator for finding the set -- a page adopting it is declaring itself a
 * load-and-save surface -- but on these three what it loads is a report. A strip naming nothing over
 * a row with no control would be worse than leaving them, so they are named here rather than
 * converted, and this list is what stops that decision being quietly re-litigated one page at a
 * time.
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
   * A settings card holds settings rows. A page rendering the strip but nothing under it would pass
   * the two checks above while having lost the rows they exist to introduce.
   *
   * `ModuleConfigForm` counts: it emits one `WSettingsRow` per prop of a module's config, so a card
   * whose whole body is a module config form (`AdminComments`') has rows -- they are just declared
   * in the shared component rather than in the page.
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
   * The hand-written stack `WSettingsRow` replaces: `WItem` + `BlueprintIcon` + two `WItemSection` +
   * two `WItemLabel`. `WItem` itself stays entirely legitimate for a LIST -- the auth strategy rail,
   * the storage target picker, a menu of modules to add -- so what is asserted is narrower: no page
   * in this set still puts a `BlueprintIcon` inside a `WItem`, which is the settings row written out
   * by hand and nothing else.
   */
  it('leaves no hand-written settings row (a BlueprintIcon inside a WItem) on any of them', () => {
    const offenders = SETTINGS_PAGES.filter((name) =>
      /<w-item[\s>][\s\S]{0,400}?<blueprint-icon/.test(sourceOf(name))
    )

    expect(offenders).toEqual([])
  })
})
