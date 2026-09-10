import { describe, expect, it } from 'vitest'
import fileTypes from './fileTypes.js'

/**
 * OpenProject #2921 replaced every real per-extension `img:` SVG with a `tabler:` Iconify name, but
 * left `page` and `redirect` (tree-node pseudo-types, not uploaded-file extensions) on their own
 * `img:` illustrations, out of that WP's scope. OpenProject #2940 ("ALL of them, not just common
 * extensions") closes that gap -- every entry in this dictionary, pseudo-types included, is
 * `tabler:` now, and there is no longer a `PSEUDO_TYPES` carve-out to maintain here.
 */
describe('fileTypes', () => {
  it('gives every entry a tabler: icon', () => {
    for (const [ext, entry] of Object.entries(fileTypes)) {
      expect(
        entry.icon.startsWith('tabler:'),
        `${ext} should resolve to a tabler: icon, got ${entry.icon}`
      ).toBe(true)
    }
  })

  it('leaves no img: color-SVG file-type icon behind', () => {
    for (const [ext, entry] of Object.entries(fileTypes)) {
      expect(entry.icon.startsWith('img:'), `${ext} should not still be an img: icon`).toBe(false)
    }
  })

  it('resolves the example extension from the WP description to tabler:file-type-pdf', () => {
    expect(fileTypes.pdf.icon).toBe('tabler:file-type-pdf')
  })

  it('keeps the folder pseudo-type on tabler:folder', () => {
    expect(fileTypes.folder.icon).toBe('tabler:folder')
  })

  it('moves the page and redirect pseudo-types off their img: illustrations (OpenProject #2940)', () => {
    expect(fileTypes.page.icon).toBe('tabler:file-text')
    expect(fileTypes.redirect.icon).toBe('tabler:arrow-forward-up')
  })

  it('covers the extensions the WP calls out as commonly missing', () => {
    for (const ext of ['doc', 'xls', 'ppt', 'md', 'html', 'js', 'ts', 'webp', 'yml']) {
      expect(fileTypes[ext], `${ext} should be a known extension`).toBeTruthy()
      expect(
        fileTypes[ext].icon.startsWith('tabler:'),
        `${ext} should resolve to a tabler: icon, got ${fileTypes[ext]?.icon}`
      ).toBe(true)
    }
  })

  it('no longer carries the xlst typo an actual .xls file could never match', () => {
    expect(fileTypes.xlst).toBeUndefined()
    expect(fileTypes.xls.icon).toBe('tabler:file-type-xls')
  })
})
