import { beforeEach, describe, expect, it } from 'vitest'
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

describe('common store: fetchLocaleStrings()', () => {
  it('resolves with the object-shaped strings reply for a known locale', async () => {
    const store = useCommonStore()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ 'common.actions.save': 'Save' })
    })

    await expect(store.fetchLocaleStrings('fr')).resolves.toEqual({
      'common.actions.save': 'Save'
    })
    expect(API_CLIENT.get).toHaveBeenCalledWith('locales/fr/strings')
  })

  it('rejects on the array-shaped reply an unrecognised locale code gets back, instead of resolving to it', async () => {
    const store = useCommonStore()
    // -> `models/locales.ts#getStrings()`'s actual reply shape for a code with no `locales` row
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

    await expect(store.fetchLocaleStrings('xx')).rejects.toThrow(/xx/)
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
})
