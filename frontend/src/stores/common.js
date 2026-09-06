import { defineStore } from 'pinia'

import { log } from '@/helpers/log'

import { useSiteStore } from './site'

/**
 * Normalize one entry `loadBlocks()` was given into `{ tag, isCustom, id }`.
 *
 * A bare tag string is shorthand for a built-in: the only kind whose import needs nothing else to be
 * found, since its compiled file is the same one on every site. A caller that already resolved the
 * block against the site's own list (`sites/:siteId/blocks`) passes the record itself instead, so a
 * custom block's `isCustom`/`id` survive as far as `blockImportUrl()` needs them.
 */
function normalizeBlockEntry(block) {
  return typeof block === 'string' ? { tag: block, isCustom: false, id: null } : block
}

/**
 * Where a block's compiled component lives, for the dynamic `import()` in `loadBlocks()` below.
 *
 * A built-in's compiled output is a flat file under `blocks/compiled`, served by the static
 * `/_blocks/` mount (`index.ts`) and addressed by its tag alone -- the same URL on every site, since
 * the file never differs. A custom block has no such file: its code is a row in the `blockCode` table
 * (`models/blocks.ts`), scoped to the site that uploaded it, and streamed back by
 * `controllers/blocks.ts` under `/_blocks/custom/:siteId/:blockId.js` -- which is why it needs the
 * site and the block's own id rather than just its tag.
 */
export function blockImportUrl(entry, siteId) {
  return entry.isCustom ? `/_blocks/custom/${siteId}/${entry.id}.js` : `/_blocks/${entry.tag}.js`
}

export const useCommonStore = defineStore('common', {
  state: () => ({
    routerLoading: false,
    locale: localStorage.getItem('locale') || 'en',
    blocksLoaded: [],
    // -> Tag -> in-flight import promise. Lets two overlapping `loadBlocks()` calls for the same
    //    tag (e.g. two page renders racing on a slow connection) share one `import()` rather than
    //    each starting their own -- `blocksLoaded` alone can't catch that, since neither call's
    //    entry has landed there yet when the other one runs its filter.
    blocksLoading: new Map()
  }),
  getters: {},
  actions: {
    async fetchLocaleStrings(locale) {
      const strings = await API_CLIENT.get(`locales/${locale}/strings`).json()
      // -> `models/locales.ts#getStrings()` replies with an empty ARRAY, not an object, for a code
      //    with no row in the `locales` table -- distinct from a real, merely-incomplete locale's
      //    (object-shaped) reply. Left uncaught, that array flows straight into `setLocaleMessage()`
      //    and every key in that locale renders as its own raw dotted path. Throwing here instead
      //    lets `App.vue#applyLocale()`'s caller skip `setLocaleMessage` for this locale entirely, so
      //    vue-i18n's `fallbackLocale: 'en'` -- eager-loaded alongside it -- takes over instead.
      //    No try/catch around this: a rejection (this one, or a network failure) is the caller's to
      //    handle (App.vue#applyLocale already does, raising a user-facing notify()).
      if (Array.isArray(strings)) {
        throw new Error(`Unrecognised locale: ${locale}`)
      }
      return strings
    },
    setLocale(locale) {
      this.locale = locale
      localStorage.setItem('locale', locale)
    },
    /**
     * Imports one block's compiled component and records the outcome. Only ever called once per
     * tag while its import is in flight -- `loadBlocks()` is what enforces that, via `blocksLoading`.
     */
    async _importBlock(entry, siteId) {
      try {
        await import(/* @vite-ignore */ blockImportUrl(entry, siteId))
        this.blocksLoaded.push(entry.tag)
      } catch (err) {
        log.warn('page', `could not load the ${entry.tag} block`, err)
      } finally {
        this.blocksLoading.delete(entry.tag)
      }
    },
    /**
     * @param blocks Tags to load, each either a bare string (a built-in) or `{ tag, isCustom, id }`
     *   (a record from `sites/:siteId/blocks` -- see `normalizeBlockEntry()`).
     */
    async loadBlocks(blocks = []) {
      const siteStore = useSiteStore()
      const entries = blocks.map(normalizeBlockEntry)
      const seen = new Set()
      const toAwait = []
      for (const entry of entries) {
        // -> Dedupe both against tags already loaded and, within this same call, against a
        //    duplicate tag appearing more than once in `entries` -- the batched call Index.vue
        //    now makes per render can legitimately contain the same tag several times.
        if (this.blocksLoaded.includes(entry.tag) || seen.has(entry.tag)) {
          continue
        }
        seen.add(entry.tag)
        let promise = this.blocksLoading.get(entry.tag)
        if (!promise) {
          promise = this._importBlock(entry, siteStore.id)
          this.blocksLoading.set(entry.tag, promise)
        }
        toAwait.push(promise)
      }
      await Promise.all(toAwait)
    }
  }
})
