import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The other half of OpenProject #1929's change here: deleting the `docsBase`-based help button left
 * `siteStore` still in use elsewhere in this component, so removing the button must not have taken
 * the store with it. The "no docsBase button" assertion itself lives in `src/docsBaseGate.test.js`
 * alongside the six other fork-invented surfaces it applies to.
 */
const source = readFileSync(join(import.meta.dirname, 'TableEditorOverlay.vue'), 'utf-8')

describe('TableEditorOverlay help link', () => {
  it('still uses siteStore elsewhere in the component', () => {
    expect(source).toContain('siteStore.overlayOpts')
  })
})
