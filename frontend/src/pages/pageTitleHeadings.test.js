import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * A source scan rather than a mount of every admin/profile screen: a tag name is a static property
 * of the markup, and each mount would need its own store/router/API fixtures to check it.
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

    // -> A generous floor the single-line Admin*.vue titles alone already clear, so a drift back
    //    toward pseudo-headings fails here rather than only a regression all the way to zero.
    expect(headingTagCount).toBeGreaterThan(20)
  })
})
