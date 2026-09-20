import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A source scan rather than a mount of every admin screen: which HTML element the title compiles to
 * is something the raw `.vue` source answers directly, without stubbing out each screen's stores
 * and child components.
 *
 * Deliberately narrow to the admin page title. `Profile*.vue` titles and the in-page section labels
 * sharing the look render through `.w-section-header` (`components/shared/WCardHeader.vue`), and the
 * remaining `text-h6` divs are dialog/section labels rather than page titles; promoting either
 * belongs to `WCardHeader`'s own configurable-heading-level work.
 */
describe('admin page titles render as <h1>, not a text-h4/text-h5 pseudo-heading', () => {
  const pagesDir = dirname(fileURLToPath(import.meta.url))
  const pageFiles = readdirSync(pagesDir)
    .filter((name) => name.startsWith('Admin') && name.endsWith('.vue'))
    .sort()

  it('found every admin page under pages/ (sanity check on the scan itself)', () => {
    expect(pageFiles.length).toBeGreaterThanOrEqual(30)
  })

  it('carries no page-title `<div>` sized by a heading class under pages/', () => {
    const offenders = []
    for (const file of pageFiles) {
      const source = readFileSync(join(pagesDir, file), 'utf-8')
      if (
        /<div\s+class="(?:text-h[45]\s+text-primary|admin-page-title)\s+animated\s+fadeInLeft"/.test(
          source
        )
      ) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  // -> `admin-page-title` is one named class declared in `AdminLayout.vue`'s own stylesheet, not a
  //    pair of utilities repeated per page.
  it('renders the page title as a real `<h1>` carrying the shared title class', () => {
    const missing = []
    for (const file of pageFiles) {
      const source = readFileSync(join(pagesDir, file), 'utf-8')
      if (!/<h1\s+class="admin-page-title\s+animated\s+fadeInLeft"/.test(source)) {
        missing.push(file)
      }
    }
    expect(missing).toEqual([])
  })

  it('closes every promoted title with `</h1>`, not a stray `</div>`', () => {
    for (const file of pageFiles) {
      const source = readFileSync(join(pagesDir, file), 'utf-8')
      const openCount = (
        source.match(/<h1\s+class="admin-page-title\s+animated\s+fadeInLeft"/g) || []
      ).length
      const closeCount = (source.match(/<\/h1>/g) || []).length
      expect(closeCount, `${file} should close as many <h1> as it opens`).toBeGreaterThanOrEqual(
        openCount
      )
    }
  })
})
