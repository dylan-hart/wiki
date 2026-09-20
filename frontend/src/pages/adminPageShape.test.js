import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A settings page is one whose whole content is a settings form, detected by its use of
 * `composables/adminSettings.js`; everything else here is a list, viewer or tool. The
 * classification is re-derived by the scan, so a new admin page fitting neither shape is caught
 * rather than silently mis-shaped.
 */
describe('admin pages are classified as settings or as list/viewer/tool', () => {
  const pagesDir = dirname(fileURLToPath(import.meta.url))

  const adminPages = readdirSync(pagesDir)
    .filter((name) => name.startsWith('Admin') && name.endsWith('.vue'))
    .map((name) => name.slice(0, -'.vue'.length))
    .sort()

  /**
   * Deliberate exceptions, named rather than sniffed for: a silent one would defeat the scan.
   * `AdminComments` and `AdminStorage` are settings forms that do more inside their own `save()`
   * than the composable's options cover.
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
