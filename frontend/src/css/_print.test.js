import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Source-inspection, not rendered DOM: `@media print` is never evaluated under happy-dom, and
 * there is no paginated print renderer to assert against. What CAN be verified is the contract
 * between the stylesheet and the templates it targets -- every class `_print.css` hides is still a
 * class the corresponding component renders (a rename on either side would otherwise silently stop
 * hiding it), and the attribution requarks/wiki#1593 (upstream) asks a print layout to retain is
 * neither in the hidden-selector list nor nested inside anything that is.
 */

const cssDir = dirname(fileURLToPath(import.meta.url))
const printScss = readFileSync(join(cssDir, '_print.css'), 'utf-8')
const appScss = readFileSync(join(cssDir, 'app.css'), 'utf-8')

function readSource(relativePath) {
  return readFileSync(join(cssDir, relativePath), 'utf-8')
}

describe('print stylesheet wiring', () => {
  it('is loaded globally by app.css', () => {
    expect(appScss).toMatch(/@import ['"]\.\/_print\.css['"]/)
  })
})

describe('print stylesheet hides only chrome classes that still exist', () => {
  const hiddenClassesToSources = {
    '.w-header': '../components/shared/WHeader.vue',
    '.w-drawer': '../components/shared/WDrawer.vue',
    // -> The page view's TOC-panel opener (and `AdminLayout`'s sidebar opener) wear this class;
    //    `MainLayout`'s own corner button is inline in the header bar
    '.corner-btn': '../pages/Index.vue',
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

    // -> Not a false positive from the tag merely being somewhere in the file: the two chrome
    //    siblings print DOES hide sit entirely after the scroll area closes, so landing inside the
    //    scroll area rules out being inside either of them.
    const pageSidebarIndex = indexSource.indexOf('class="page-sidebar"')
    const pageActionsColIndex = indexSource.indexOf('<page-actions-col')
    expect(pageSidebarIndex).toBeGreaterThan(scrollAreaEnd)
    expect(pageActionsColIndex).toBeGreaterThan(scrollAreaEnd)
  })
})
