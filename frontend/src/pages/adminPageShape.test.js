import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2702 — the decision about which admin pages are settings pages and which are lists,
 * viewers and tools, and therefore which Cardinal treatment each one takes.
 *
 * `docs/decisions/admin-list-viewer-tool-page-pattern.md` names thirteen pages. That list was
 * derived by grep, not by hand -- the Task's own filing got it wrong the first time by deriving it
 * by elimination -- and a list derived by grep goes stale the moment a page is added or converted.
 * This is the guard that keeps it honest, in the same source-scanning style as
 * `pageTitles.test.js`: a new admin page cannot land without somebody deciding which of the two
 * shapes it is and saying so in the decision record.
 *
 * The classification, which the scan below re-derives rather than restates:
 *
 * - a **settings page** is one whose whole content is a settings form. All but two of them share
 *   `composables/adminSettings.js` for their load/save skeleton, and the two that do not --
 *   `AdminComments` and `AdminStorage` -- are the hold-outs CLAUDE.md already documents, each doing
 *   more inside its own `save()` than the composable's options cover. They take `WSettingsCard` and
 *   `WSettingsRow` (roll-out: #2700).
 * - a **list, viewer or tool page** is everything else except `AdminDashboard`, which is neither
 *   (it is the admin area's landing screen, designed in handoff 1). What those take is the subject
 *   of the decision record.
 */
describe('admin pages are classified as settings or as list/viewer/tool, and the decision record says which', () => {
  const pagesDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(pagesDir, '..', '..', '..')
  const decisionPath = join(repoRoot, 'docs', 'decisions', 'admin-list-viewer-tool-page-pattern.md')

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

  it('has a decision record for the list/viewer/tool shape', () => {
    expect(existsSync(decisionPath)).toBe(true)
  })

  it('names every list, viewer and tool page in that decision record', () => {
    const decision = readFileSync(decisionPath, 'utf8')
    const missing = listViewerToolPages.filter((page) => !decision.includes(page))

    expect(missing).toEqual([])
  })

  it('names no settings page as one of them', () => {
    const decision = readFileSync(decisionPath, 'utf8')
    // -> The set is enumerated in one paragraph, as a comma-separated run of backticked names.
    const enumerated = decision
      .split('\n\n')
      .find((para) => para.includes('`AdminAuditLog`') && para.includes('`AdminWebhooks`'))

    expect(enumerated).toBeTruthy()
    const named = [...enumerated.matchAll(/`(Admin[A-Za-z]+)`/g)].map((m) => m[1]).sort()

    expect(named).toEqual(listViewerToolPages)
  })
})
