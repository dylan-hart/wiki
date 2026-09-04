import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import TableEditorOverlay from './TableEditorOverlay.vue'
import { createTestI18n } from '../../test/i18n.js'

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

/**
 * OpenProject #2530: `editing` (and therefore the starting grid) now reads off the `overlayOpts` prop
 * `MainOverlayDialog.vue` forwards, not `siteStore.overlayOpts` directly.
 */
describe('TableEditorOverlay editing state (OpenProject #2530)', () => {
  function mountOverlay(overlayOpts) {
    setActivePinia(createPinia())
    const i18n = createTestI18n({})
    return mount(TableEditorOverlay, {
      props: overlayOpts ? { overlayOpts } : {},
      global: { plugins: [i18n] }
    })
  }

  it('starts with the default blank 3x3 grid when no overlayOpts prop is given', () => {
    const wrapper = mountOverlay()

    expect(wrapper.vm.state.rows).toEqual([
      ['Column 1', 'Column 2', 'Column 3'],
      ['', '', ''],
      ['', '', '']
    ])
    expect(wrapper.vm.state.replace).toBeNull()
  })

  it('parses overlayOpts.source into the starting grid, and carries replace.startLine/endLine', () => {
    const wrapper = mountOverlay({
      source: '| A | B |\n| --- | --- |\n| x | y |',
      startLine: 4,
      endLine: 6
    })

    expect(wrapper.vm.state.rows).toEqual([
      ['A', 'B'],
      ['x', 'y']
    ])
    expect(wrapper.vm.state.replace).toEqual({ startLine: 4, endLine: 6 })
  })
})
