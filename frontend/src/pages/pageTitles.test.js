import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1637 ("Promote the 30-odd admin and profile page titles to `<h1>`").
 *
 * Every `pages/Admin*.vue` repeated the same pseudo-heading verbatim --
 * `<div class="text-h5 text-primary animated fadeInLeft">{{ t('admin.*.title') }}</div>` -- a `<div>`
 * carrying a `text-h5` Tailwind class purely for size, with no real heading element behind it. A
 * screen reader's heading navigation (the H key / rotor) found nothing to land on for the one thing
 * on each admin screen most worth jumping straight to: its title. Fixed by changing the element to
 * `<h1>`; the Cardinal re-skin then replaced the repeated utility pair with one named class,
 * `admin-page-title`, declared in `AdminLayout.vue`'s own stylesheet.
 *
 * This is a source-level regression test in the same style as `_page-contents.test.js`: it reads the
 * raw `.vue` source of every page under `pages/` rather than mounting each component (36 admin
 * screens, most pulling in heavy child components/stores that a mount would need to stub out for no
 * benefit here -- the thing under test is which HTML element the title compiles to, which the source
 * already answers directly).
 *
 * Deliberately narrow to the page-title div this work package actually owns: `pages/Profile*.vue`
 * page titles and the few in-page section labels sharing this exact class (`pages/Inbox*.vue`,
 * `pages/TagsBrowse.vue`) render through `.w-section-header` (`WCardHeader`'s own visual class, see
 * `components/shared/WCardHeader.vue`), not `text-h4`/`text-h5` -- promoting those is
 * `WCardHeader`'s own configurable-heading-level work (OpenProject #1633), not this one. A handful of
 * `text-h6` divs also remain by design -- in-page dialog/section labels (`AdminBlocks.vue`'s
 * credentials/rate-limit headers, `AdminGeneral.vue`'s toolbar title, `AdminIcons.vue`'s "add set"
 * header, `Index.vue`'s locked/not-found placeholders) are not page titles and are explicitly left
 * for that same `WCardHeader` change.
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

  /*
    `admin-page-title`, not `text-h5 text-primary`: the Cardinal re-skin gave all 37 of these one
    named class, declared once in `AdminLayout.vue`'s own stylesheet, rather than a pair of utilities
    repeated per page. The element is still what this test is about -- a real `<h1>`.
  */
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
