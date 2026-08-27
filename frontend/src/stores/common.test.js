import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { blockImportUrl, useCommonStore } from './common.js'
import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('common store: blockImportUrl()', () => {
  it('addresses a built-in block by its flat, site-independent compiled-output URL', () => {
    expect(blockImportUrl({ tag: 'block-alert', isCustom: false }, 'site-1')).toBe(
      '/_blocks/block-alert.js'
    )
  })

  it('treats a record with no isCustom flag the same way, as the built-in default', () => {
    expect(blockImportUrl({ tag: 'block-alert' }, 'site-1')).toBe('/_blocks/block-alert.js')
  })

  it('addresses a custom block by site and id, under /_blocks/custom/', () => {
    expect(blockImportUrl({ tag: 'block-widget', isCustom: true, id: 'block-1' }, 'site-1')).toBe(
      '/_blocks/custom/site-1/block-1.js'
    )
  })
})

describe('common store: loadBlocks()', () => {
  it('accepts bare tag strings as built-in shorthand, and does not mark a failed import as loaded', async () => {
    const store = useCommonStore()

    // -> Nothing under /_blocks/ actually exists in this test environment, so the dynamic import
    //    rejects -- exercising exactly the failure path a reader hits for a block nobody registered.
    //    The tag is left out of `blocksLoaded` so a later, real load attempt is not skipped.
    await store.loadBlocks(['block-nonexistent'])

    expect(store.blocksLoaded).not.toContain('block-nonexistent')
  })

  it('does not re-attempt a tag already recorded as loaded', async () => {
    const store = useCommonStore()
    store.blocksLoaded = ['block-alert']

    await store.loadBlocks(['block-alert'])

    // -> Unchanged rather than appended a second time
    expect(store.blocksLoaded).toEqual(['block-alert'])
  })

  it('resolves a custom block’s URL against the current site before attempting the import', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-42'
    const store = useCommonStore()

    await store.loadBlocks([{ tag: 'block-widget', isCustom: true, id: 'block-9' }])

    // -> The import itself fails in this environment (no such route is actually served here), so the
    //    only thing this test can observe is that the failure was NOT recorded as loaded -- the URL
    //    construction itself is covered directly by the blockImportUrl() tests above.
    expect(store.blocksLoaded).not.toContain('block-widget')
  })

  /**
   * OpenProject #1734: `toLoad`'s `!blocksLoaded.includes(...)` filter only screens out a tag that
   * has ALREADY finished loading -- two calls racing for the same not-yet-loaded tag both used to
   * pass it and both `import()`, each appending the tag to `blocksLoaded` once its own import
   * resolved. A tag whose import actually succeeds is the only way to observe the fix (a failed
   * import never reaches the `blocksLoaded.push()` line at all), so this stubs `import()`'s
   * underlying failure into a success by resolving the returned promise directly rather than relying
   * on a real module existing under `/_blocks/` in this environment.
   */
  it('appends blocksLoaded exactly once for two concurrent loadBlocks() calls racing for the same tag', async () => {
    const store = useCommonStore()
    let resolveImport
    const importSpy = vi.spyOn(store, '_importBlock').mockImplementation(async (entry) => {
      await new Promise((resolve) => (resolveImport = resolve))
      store.blocksLoaded.push(entry.tag)
    })

    const first = store.loadBlocks(['block-race'])
    const second = store.loadBlocks(['block-race'])
    resolveImport()
    await Promise.all([first, second])

    expect(importSpy).toHaveBeenCalledTimes(1)
    expect(store.blocksLoaded.filter((tag) => tag === 'block-race')).toEqual(['block-race'])
  })
})
