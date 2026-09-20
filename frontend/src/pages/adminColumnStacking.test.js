import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../../test/sourceFiles.js'

/**
 * The list-plus-panel admin pages sit in a `flex flex-wrap` row. A panel on `flex-1` has a zero
 * flex basis, which gives the row no reason to wrap, so the panel is squeezed to a sliver beside
 * a fixed-width column instead of stacking under it (`AdminStorage.layout.test.js` measures that
 * in a real browser). This scan keeps the shape from creeping back onto another page.
 */
describe('admin pages stack their columns instead of squeezing them', () => {
  const pagesDir = dirname(fileURLToPath(import.meta.url))
  const pages = listSourceFiles(pagesDir, { ext: ['.vue'] }).filter((full) =>
    /\/Admin[A-Za-z]+\.vue$/.test(full)
  )

  it.each(pages.map((full) => [full.slice(pagesDir.length + 1), readFileSync(full, 'utf8')]))(
    '%s',
    (_name, source) => {
      expect(source).not.toMatch(/<w-list style="min-width: \d+px"/)
      expect(source).not.toMatch(/class="min-w-0 flex-1" v-if=/)
    }
  )
})
