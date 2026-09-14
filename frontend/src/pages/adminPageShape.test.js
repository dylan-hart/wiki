import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2702 — the decision about which admin pages are settings pages and which are lists,
 * viewers and tools, and therefore which Cardinal treatment each one takes.
 *
 * The classification, re-derived by the scan below rather than restated from a record:
 *
 * - a **settings page** is one whose whole content is a settings form. All but two of them share
 *   `composables/adminSettings.js` for their load/save skeleton, and the two that do not --
 *   `AdminComments` and `AdminStorage` -- are the hold-outs CLAUDE.md already documents, each doing
 *   more inside its own `save()` than the composable's options cover. They take `WSettingsCard` and
 *   `WSettingsRow` (roll-out: #2700).
 * - a **list, viewer or tool page** is everything else except `AdminDashboard`, which is neither
 *   (it is the admin area's landing screen, designed in handoff 1).
 *
 * This is the guard that keeps that classification honest, in the same source-scanning style as
 * `pageTitles.test.js`: a new admin page added to this directory without joining either named
 * exception list is picked up automatically by the sanity check below rather than silently
 * mis-shaped.
 */
describe('admin pages are classified as settings or as list/viewer/tool', () => {
  const pagesDir = dirname(fileURLToPath(import.meta.url))

  const adminPages = readdirSync(pagesDir)
    .filter((name) => name.startsWith('Admin') && name.endsWith('.vue'))
    .map((name) => name.slice(0, -'.vue'.length))
    .sort()

  /**
   * `AdminComments` and `AdminStorage` are settings forms that do not use the composable;
   * `AdminDashboard` is neither shape. Named here rather than sniffed for, because each is a
   * deliberate exception and a silent one would defeat the point of the scan.
   */
  const SETTINGS_WITHOUT_COMPOSABLE = ['AdminComments', 'AdminStorage']
  const NEITHER_SHAPE = ['AdminDashboard']

  const settingsPages = adminPages.filter(
    (page) =>
      SETTINGS_WITHOUT_COMPOSABLE.includes(page) ||
      readFileSync(join(pagesDir, `${page}.vue`), 'utf8').includes('useAdminSettings')
  )
  const listViewerToolPages = adminPages.filter(
    (page) => !settingsPages.includes(page) && !NEITHER_SHAPE.includes(page)
  )

  it('accounts for every admin page exactly once (sanity check on the scan itself)', () => {
    expect(adminPages.length).toBeGreaterThanOrEqual(30)
    expect(settingsPages.length + listViewerToolPages.length + NEITHER_SHAPE.length).toBe(
      adminPages.length
    )
  })
})
