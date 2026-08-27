import { defineStore } from 'pinia'

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
    blocksLoaded: []
  }),
  getters: {},
  actions: {
    async fetchLocaleStrings(locale) {
      // -> No try/catch here: a rejection is the caller's to handle (App.vue#applyLocale already
      //    does, raising a user-facing notify()). Wrapping a returned promise in try/catch here would
      //    do nothing -- the rejection settles after this function has already returned.
      return API_CLIENT.get(`locales/${locale}/strings`).json()
    },
    setLocale(locale) {
      this.locale = locale
      localStorage.setItem('locale', locale)
    },
    /**
     * @param blocks Tags to load, each either a bare string (a built-in) or `{ tag, isCustom, id }`
     *   (a record from `sites/:siteId/blocks` -- see `normalizeBlockEntry()`).
     */
    async loadBlocks(blocks = []) {
      const siteStore = useSiteStore()
      const entries = blocks.map(normalizeBlockEntry)
      const toLoad = entries.filter((entry) => !this.blocksLoaded.includes(entry.tag))
      for (const entry of toLoad) {
        try {
          await import(/* @vite-ignore */ blockImportUrl(entry, siteStore.id))
          this.blocksLoaded.push(entry.tag)
        } catch (err) {
          console.warn(`Failed to load ${entry.tag}: ${err.message}`)
        }
      }
    }
  }
})
