import { describe, expect, it } from 'vitest'

import { collectBlocksToLoad } from './blockScan'

/**
 * `:not(:defined)` is what the scan selects on, so nothing here registers a custom element: every
 * `block-*` in these fixtures is undefined, which is exactly the state a freshly-rendered page is in.
 */
function render(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('collectBlocksToLoad', () => {
  it('has nothing to load without a content element', () => {
    expect(collectBlocksToLoad(null, { gallery: { isCustom: false, id: 'a' } })).toEqual([])
  })

  it('resolves an enabled block against the site index, keeping isCustom/id', () => {
    const root = render('<block-gallery></block-gallery>')
    expect(collectBlocksToLoad(root, { gallery: { isCustom: true, id: 'abc' } })).toEqual([
      { tag: 'block-gallery', isCustom: true, id: 'abc' }
    ])
  })

  it('dedupes a tag embedded several times down the page', () => {
    const root = render('<block-gallery></block-gallery><block-gallery></block-gallery>')
    expect(collectBlocksToLoad(root, { gallery: { isCustom: false, id: null } })).toEqual([
      { tag: 'block-gallery', isCustom: false, id: null }
    ])
  })

  it('skips a block absent from the index — a disabled block must not leak a working URL', () => {
    const root = render('<block-secret></block-secret>')
    expect(collectBlocksToLoad(root, {})).toEqual([])
  })

  it('keeps a child block whose parent is enabled', () => {
    const root = render('<block-tabs><block-tab></block-tab></block-tabs>')
    expect(collectBlocksToLoad(root, { tabs: { isCustom: false, id: null } })).toEqual([
      { tag: 'block-tabs', isCustom: false, id: null },
      'block-tab'
    ])
  })

  it('passes an ordinary unknown custom element through as a bare tag', () => {
    const root = render('<my-widget></my-widget>')
    expect(collectBlocksToLoad(root, {})).toEqual(['my-widget'])
  })
})
