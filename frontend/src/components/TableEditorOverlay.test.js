import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1929: `/guide/table-editor` names a table-editor concept this fork invented (no
 * upstream Wiki.js docs site can describe it), so the `docsBase`-based help button was deleted rather
 * than left pointing at a page that does not exist. Reads the raw source rather than mounting the
 * component -- a full mount is out of proportion for asserting that some markup is simply gone -- so
 * this also guards against the button quietly being reintroduced. `siteStore` itself is still used
 * elsewhere in this component (`overlayOpts`, the overlay-close patch), so only the button is gone.
 */
const source = readFileSync(join(import.meta.dirname, 'TableEditorOverlay.vue'), 'utf-8')

describe('TableEditorOverlay help link', () => {
  it('has no docsBase-based help/docs button', () => {
    expect(source).not.toContain('docsBase')
  })

  it('still uses siteStore elsewhere in the component', () => {
    expect(source).toContain('siteStore.overlayOpts')
  })
})
