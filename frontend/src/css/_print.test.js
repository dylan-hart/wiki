import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression coverage for OpenProject #821: printing a page used to print the whole app shell
 * (header, side nav, ToC/tags/rating column, page action buttons, floating corner buttons) along
 * with the article. `_print.scss` fixes that with `@media print` rules keyed off the classes those
 * elements render with.
 *
 * These are source-inspection tests, not rendered-DOM ones -- `@media print` is never evaluated
 * under Vitest's `happy-dom` environment (there is no real paginated print renderer to assert
 * against, see `AdminLayout.test.js`'s own `count-badge` test for the same style of check used
 * elsewhere in this codebase for a CSS rule that can't be exercised by mounting). What CAN be
 * verified here is the CONTRACT between the stylesheet and the templates it targets: that every
 * class `_print.scss` hides is still the class the corresponding component actually renders
 * (catching a rename that would silently stop hiding it), and that the one thing print is required
 * to keep -- `FooterNav`'s copyright/license line and "Powered by Cardinal.js" credit, the
 * attribution requarks/wiki#1593 (upstream) asks a print layout to retain -- is neither in the
 * hidden-selector list nor nested inside anything that is.
 */

const cssDir = dirname(fileURLToPath(import.meta.url))
const printScss = readFileSync(join(cssDir, '_print.scss'), 'utf-8')
const appScss = readFileSync(join(cssDir, 'app.scss'), 'utf-8')

function readSource(relativePath) {
  return readFileSync(join(cssDir, relativePath), 'utf-8')
}

describe('print stylesheet wiring', () => {
  it('is loaded globally by app.scss', () => {
    expect(appScss).toMatch(/@use ['"]print['"]/)
  })
})

describe('print stylesheet hides only chrome classes that still exist', () => {
  // -> Every selector `_print.scss` hides outright, mapped to the component whose template is
  //    supposed to still be rendering that class. A future rename on either side that isn't kept in
  //    step would otherwise fail silently -- the chrome would just stop being hidden.
  const hiddenClassesToSources = {
    '.w-header': '../components/shared/WHeader.vue',
    '.w-drawer': '../components/shared/WDrawer.vue',
    '.corner-btn': '../layouts/MainLayout.vue',
    '.page-breadcrumbs': '../pages/Index.vue',
    '.page-header-actions': '../components/PageHeader.vue',
    '.page-sidebar': '../pages/Index.vue',
    '.page-sidebar-scrim': '../pages/Index.vue',
    '.page-actions': '../components/PageActionsCol.vue',
    '.w-notifications': '../components/shared/WNotifications.vue',
    '.w-loading': '../components/shared/WLoadingOverlay.vue',
    '.main-overlay': '../components/MainOverlayDialog.vue'
  }

  it.each(Object.entries(hiddenClassesToSources))(
    '%s is still a real class rendered by %s',
    (className, relativePath) => {
      const source = readSource(relativePath)
      const token = className.slice(1)
      // -> Matches inside a `class="..."` attribute specifically, not any bare substring -- so e.g.
      //    `.page-actions` can't accidentally pass by matching inside `page-header-actions`.
      const classAttrPattern = new RegExp(`class="[^"]*\\b${token}\\b[^"]*"`)
      expect(source).toMatch(classAttrPattern)
    }
  )

  it('lists every one of those classes inside its @media print block', () => {
    const printBlock = printScss.slice(printScss.indexOf('@media print'))
    for (const className of Object.keys(hiddenClassesToSources)) {
      expect(printBlock).toContain(className)
    }
  })
})

describe('print stylesheet leaves attribution alone', () => {
  it('never hides the site footer or FooterNav', () => {
    expect(printScss).not.toMatch(/\.w-footer\b/)
    expect(printScss).not.toMatch(/\.site-footer\b/)
    expect(printScss).not.toMatch(/footer-nav/i)
  })

  it('keeps FooterNav mounted inside the scrolling article column that print leaves alone', () => {
    const indexSource = readSource('../pages/Index.vue')

    const scrollAreaClassIndex = indexSource.indexOf('class="page-container-scrl"')
    const scrollAreaTagStart = indexSource.lastIndexOf('<w-scroll-area', scrollAreaClassIndex)
    const scrollAreaEnd = indexSource.indexOf('</w-scroll-area>', scrollAreaClassIndex)
    expect(scrollAreaTagStart).toBeGreaterThan(-1)
    expect(scrollAreaEnd).toBeGreaterThan(scrollAreaClassIndex)

    const scrollAreaBody = indexSource.slice(scrollAreaTagStart, scrollAreaEnd)
    expect(scrollAreaBody).toContain('<footer-nav')

    // -> And not merely a false positive from being anywhere in the file: the two chrome siblings
    //    that print DOES hide -- the ToC/tags/rating column and the floating action rail -- are both
    //    later siblings of the article column in document order, entirely after the scroll area
    //    closes, so `footer-nav` landing inside the scroll area is not also inside either of them.
    const pageSidebarIndex = indexSource.indexOf('class="page-sidebar"')
    const pageActionsColIndex = indexSource.indexOf('<page-actions-col')
    expect(pageSidebarIndex).toBeGreaterThan(scrollAreaEnd)
    expect(pageActionsColIndex).toBeGreaterThan(scrollAreaEnd)
  })
})
