import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * WIcon.vue's scoped `.w-icon { width: 1em; height: 1em }` outranks a plain global `.admin-icon`
 * rule on specificity, so an admin header `<w-icon class="admin-icon">` with no `size` prop collapses
 * to a 1em box. The design draws a 34px glyph inside the `.admin-page-icon` plate
 * (`AdminLayout.vue`). A template scan rather than a mount per page: what is pinned is a textual
 * property of the markup.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const PAGES_DIR = join(SRC_DIR, 'pages')

function findWIconTags(source) {
  const templateMatch = source.match(/<template[^>]*>([\s\S]*)<\/template>/)
  if (!templateMatch) return []
  const template = templateMatch[1].replace(/<!--[\s\S]*?-->/g, '')
  return template.match(/<w-icon\b[^>]*?\/?>/g) ?? []
}

function isAdminHeaderIcon(tag) {
  // -> Whole word: AdminIcons.vue also carries `admin-icons-icon` and `admin-icons-sample`
  return /class="[^"]*\badmin-icon\b[^"]*"/.test(tag)
}

describe('every admin page header <w-icon class="admin-icon"> is a sized glyph in a plate', () => {
  const adminPageFiles = listSourceFiles(PAGES_DIR, { ext: ['.vue'] }).filter((f) =>
    /Admin[^/]*\.vue$/.test(f)
  )

  it('scans a non-trivial number of Admin*.vue pages', () => {
    // -> A walk or filter that matched nothing would pass every case below vacuously
    expect(adminPageFiles.length).toBeGreaterThan(30)
  })

  for (const file of adminPageFiles) {
    const relPath = file.slice(SRC_DIR.length + 1)
    const source = readFileSync(file, 'utf-8')
    const headerIconTags = findWIconTags(source).filter(isAdminHeaderIcon)

    if (headerIconTags.length === 0) continue

    it(`${relPath}: header <w-icon class="admin-icon"> carries size="34px", inside a plate`, () => {
      for (const tag of headerIconTags) {
        expect(tag).toMatch(/\bsize="34px"/)
      }
      expect(source).toContain('<div class="admin-page-icon flex-none animated fadeInLeft">')
      expect(source).toContain('<i class="admin-page-icon__marks" aria-hidden="true" />')
    })
  }
})
