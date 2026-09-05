import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * OpenProject #2332 ("Most admin area header icons render tiny -- WIcon's scoped .w-icon rule beats
 * the global .admin-icon 64px height").
 *
 * `frontend/src/layouts/AdminLayout.vue` declares a plain global rule, `.admin-icon { height: 64px }`,
 * meant to size every admin page's header icon. It only actually applies when `.admin-icon` sits on a
 * bare element (AdminPages.vue's `<img class="admin-icon">`): every other admin page instead applies
 * the class to `<w-icon class="admin-icon">`, and WIcon.vue's own scoped style
 * (`.w-icon[data-v-hash] { width: 1em; height: 1em }`) outranks the plain global class on specificity,
 * so the intended 64px height never took effect there -- the icon fell back to a 1em box against
 * whatever ambient font-size surrounded it.
 *
 * The fix is to feed WIcon's own `size` prop (which sets `font-size`, the thing that actually
 * controls `.w-icon`'s em-based box) rather than trying to out-specificity WIcon's scoped rule from
 * outside. This is a source-level regression test in the same style as `imgAlt.test.js` -- a plain
 * template scan across every admin page rather than mounting each of the 37 pages individually, since
 * what is being pinned down is a textual property of the markup, not rendered behaviour that differs
 * page to page.
 *
 * The size the scan pins has since changed with the shape around it: the icon no longer IS the 64px
 * plate, it sits inside one (`.admin-page-icon`, declared in `AdminLayout.vue`, with the four
 * blueprint corner marks overhanging it), and the design draws a 34px glyph in that 64px box. The
 * defect the original gate pins down is unchanged -- an `.admin-icon` with no `size` still collapses
 * to a 1em box -- so the scan still runs, against the size the design now asks for, and additionally
 * pins the plate the glyph has to be inside, since a header icon that escaped it would draw a naked
 * 34px glyph where every other page draws a framed one.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const PAGES_DIR = join(SRC_DIR, 'pages')

/** Every `<w-icon ...>` tag (not just ones with `class="admin-icon"`) so a moved/renamed class can't hide from this scan. */
function findWIconTags(source) {
  const templateMatch = source.match(/<template[^>]*>([\s\S]*)<\/template>/)
  if (!templateMatch) return []
  const template = templateMatch[1].replace(/<!--[\s\S]*?-->/g, '')
  return template.match(/<w-icon\b[^>]*?\/?>/g) ?? []
}

function isAdminHeaderIcon(tag) {
  // -> Matches the class as a whole word so `admin-icon` doesn't also match `admin-icons-icon` or
  //    `admin-icons-sample` (AdminIcons.vue carries both, only the first is the page header icon).
  return /class="[^"]*\badmin-icon\b[^"]*"/.test(tag)
}

describe('every admin page header <w-icon class="admin-icon"> is a sized glyph in a plate', () => {
  const adminPageFiles = listSourceFiles(PAGES_DIR, { ext: ['.vue'] }).filter((f) =>
    /Admin[^/]*\.vue$/.test(f)
  )

  it('scans a non-trivial number of Admin*.vue pages', () => {
    // -> A canary against the file walk or filter silently matching nothing, which would otherwise
    //    make every case below vacuously pass.
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
