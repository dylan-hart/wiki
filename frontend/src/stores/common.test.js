import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { blockImportUrl, useCommonStore } from './common.js'
import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * Regression coverage for OpenProject #1769: `desiredLocale` used to duplicate `locale` -- both
 * seeded from the same `localStorage` key and both written by `setLocale()` -- as a leftover from a
 * two-field design `App.vue` no longer needs. `setLocale()` now owns exactly one field.
 */
describe('common store: setLocale()', () => {
  it('writes the single locale field, plus localStorage, and nothing else', () => {
    const store = useCommonStore()

    store.setLocale('fr')

    expect(store.locale).toBe('fr')
    expect(store.desiredLocale).toBeUndefined()
    expect(localStorage.getItem('locale')).toBe('fr')
  })
})

/**
 * `fetchLocaleStrings()` used to wrap `return API_CLIENT.get(...).json()` in a try/catch that could
 * never fire -- a `return <promise>` inside an async function settles the returned promise after the
 * try block has already been exited, so the rejection never reached the catch. Asserting the
 * rejection reaches the CALLER unchanged is what pins that dead handler gone rather than merely
 * deleted-and-untested.
 */
describe('common store: fetchLocaleStrings()', () => {
  it('propagates a request rejection to the caller', async () => {
    const store = useCommonStore()
    const failure = new Error('network down')
    API_CLIENT.get.mockImplementationOnce(() => {
      throw failure
    })

    await expect(store.fetchLocaleStrings('fr')).rejects.toThrow('network down')
  })

  it('resolves with the fetched strings on success', async () => {
    const store = useCommonStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ hello: 'bonjour' }) })

    await expect(store.fetchLocaleStrings('fr')).resolves.toEqual({ hello: 'bonjour' })
    expect(API_CLIENT.get).toHaveBeenCalledWith('locales/fr/strings')
  })
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

  it('propagates a rejected API_CLIENT.get() to the caller without swallowing it', async () => {
    const store = useCommonStore()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })

    await expect(store.fetchLocaleStrings('en')).rejects.toThrow('network')
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
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

  describe('deduping repeated tags', () => {
    let warnSpy

    beforeEach(() => {
      // -> Nothing under /_blocks/ exists in this test environment, so every import attempt
      //    rejects and logs one console.warn -- a 1:1 stand-in for "one real import() attempt
      //    was made", which is what these tests are actually asserting: not zero, not two.
      //    The store writes that line through `helpers/log.js` rather than `console` directly
      //    (OpenProject #2682), and the helper reaches `console.warn` whenever
      //    `import.meta.env.DEV` is true -- which it is under Vitest -- so this spy still counts
      //    exactly the attempts it always did.
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('records each tag exactly once when called with duplicates in a single call', async () => {
      const store = useCommonStore()

      await store.loadBlocks(['block-dup', 'block-dup', 'block-dup'])

      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('records each tag exactly once when called twice concurrently with the same tag', async () => {
      const store = useCommonStore()

      // -> Neither call is awaited before the other starts, so both run their `blocksLoaded`
      //    filter before either import has resolved -- the case a plain array-membership check
      //    can't catch on its own, and `blocksLoading`'s in-flight tracking exists to close.
      await Promise.all([
        store.loadBlocks(['block-concurrent']),
        store.loadBlocks(['block-concurrent'])
      ])

      expect(warnSpy).toHaveBeenCalledTimes(1)
    })
  })
})
