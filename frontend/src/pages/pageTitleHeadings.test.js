import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1630 / task 1637: `pages/AdminGeneral.vue:8`, repeated verbatim at the top of every
 * other `Admin*.vue` (and the equivalent `.w-section-header` divs at the top of every
 * `Profile*.vue`), used to be a plain `<div class="text-h5 ...">` -- a heading in size only, not in
 * role or level, so a screen reader's heading navigation found nothing here. Across all of
 * `frontend/` there were exactly two real heading elements before this fix
 * (`components/PageComments.vue`, `pages/Login.vue`, both `<h2>`).
 *
 * A source-scan test rather than one mounting every page: mounting all 30-odd admin/profile screens
 * (several needing their own store/router/API fixtures) to check a single tag name would be a lot of
 * fixture weight for what is, in the end, a static property of the markup -- the same tradeoff
 * `css/_page-contents.test.js` makes for its own SCSS-source assertions.
 */
describe('page title heading hierarchy (OpenProject #1630)', () => {
  const pagesDir = dirname(fileURLToPath(import.meta.url))
  const vueFiles = readdirSync(pagesDir).filter((name) => name.endsWith('.vue'))

  it('leaves no page-title <div class="text-h4/text-h5 ..."> under frontend/src/pages', () => {
    const offenders = vueFiles.filter((name) => {
      const source = readFileSync(join(pagesDir, name), 'utf-8')
      return /<div[^>]*\bclass="[^"]*\btext-h[45]\b/.test(source)
    })

    expect(offenders).toEqual([])
  })

  it('renders a real heading hierarchy under frontend/src/pages, not the pre-fix app-wide count of 2', () => {
    const headingTagCount = vueFiles.reduce((total, name) => {
      const source = readFileSync(join(pagesDir, name), 'utf-8')
      const matches = source.match(/<h[1-6][ >]/g)
      return total + (matches ? matches.length : 0)
    }, 0)

    // -> The 31 single-line Admin*.vue titles alone already clear this bar; a generous but
    //    meaningfully-above-2 floor, so this fails loudly if a future edit regresses back toward
    //    pseudo-headings rather than only if it regresses all the way to zero.
    expect(headingTagCount).toBeGreaterThan(20)
  })
})
