import { describe, expect, it } from 'vitest'
import fileTypes from './fileTypes.js'

/**
 * OpenProject #2921: every real per-extension icon (color-coded `img:` SVGs) is replaced with a
 * `tabler:` Iconify name, matching the rest of File Manager's already-tabler chrome. `folder`,
 * `page` and `redirect` are pseudo-types (tree-node kinds, not uploaded-file extensions) and are
 * out of this WP's scope -- see the work package for the discrepancy note on `page`/`redirect`
 * still being `img:` today.
 */
const PSEUDO_TYPES = ['folder', 'page', 'redirect']

describe('fileTypes', () => {
  it('gives every real file-extension entry a tabler: icon', () => {
    for (const [ext, entry] of Object.entries(fileTypes)) {
      if (PSEUDO_TYPES.includes(ext)) {
        continue
      }
      expect(
        entry.icon.startsWith('tabler:'),
        `${ext} should resolve to a tabler: icon, got ${entry.icon}`
      ).toBe(true)
    }
  })

  it('leaves no img: color-SVG file-type icon behind', () => {
    for (const [ext, entry] of Object.entries(fileTypes)) {
      if (PSEUDO_TYPES.includes(ext)) {
        continue
      }
      expect(entry.icon.startsWith('img:'), `${ext} should not still be an img: icon`).toBe(false)
    }
  })

  it('resolves the example extension from the WP description to tabler:file-type-pdf', () => {
    expect(fileTypes.pdf.icon).toBe('tabler:file-type-pdf')
  })

  it('keeps the folder pseudo-type on tabler:folder', () => {
    expect(fileTypes.folder.icon).toBe('tabler:folder')
  })
})
