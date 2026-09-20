import { defineStore } from 'pinia'

import { log } from '@/helpers/log'

import { useSiteStore } from './site'

/**
 * A bare tag string is shorthand for a built-in, the only kind whose import needs nothing else to be
 * found. A caller that already resolved the block against the site's own list passes the record
 * itself, so a custom block's `isCustom`/`id` survive as far as `blockImportUrl()` needs them.
 */
function normalizeBlockEntry(block) {
  return typeof block === 'string' ? { tag: block, isCustom: false, id: null } : block
}

/**
 * A built-in's compiled output is a flat file under `/_blocks/`, addressed by tag alone because it
 * is the same file on every site. A custom block has no such file -- its code is a per-site database
 * row streamed back by the backend -- so its URL needs the site and the block's own id.
 */
export function blockImportUrl(entry, siteId) {
  return entry.isCustom ? `/_blocks/custom/${siteId}/${entry.id}.js` : `/_blocks/${entry.tag}.js`
}

export const useCommonStore = defineStore('common', {
  state: () => ({
    routerLoading: false,
    locale: localStorage.getItem('locale') || 'en',
    blocksLoaded: [],
    // -> Tag -> in-flight import promise, so two overlapping `loadBlocks()` calls for the same tag
    //    share one `import()`. `blocksLoaded` alone cannot catch that: neither call's entry has
    //    landed there yet when the other runs its filter.
    blocksLoading: new Map()
  }),
  getters: {},
  actions: {
    async fetchLocaleStrings(locale) {
      const strings = await API_CLIENT.get(`locales/${locale}/strings`).json()
      // -> The backend replies with an empty ARRAY, not an object, for a code with no locale row --
      //    distinct from a real but merely incomplete locale's object-shaped reply. Left uncaught,
      //    that array reaches `setLocaleMessage()` and every key renders as its raw dotted path;
      //    throwing lets the caller skip `setLocaleMessage` so vue-i18n's `en` fallback takes over.
      //    Deliberately not caught here: a rejection is the caller's to turn into a notification.
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
     * Must only ever be called once per tag while that tag's import is in flight -- `loadBlocks()`
     * is what enforces it, via `blocksLoading`.
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
     * @param blocks Each entry is either a bare tag string (a built-in) or a `{ tag, isCustom, id }`
     *   record from `sites/:siteId/blocks`.
     */
    async loadBlocks(blocks = []) {
      const siteStore = useSiteStore()
      const entries = blocks.map(normalizeBlockEntry)
      const seen = new Set()
      const toAwait = []
      for (const entry of entries) {
        // -> `seen` covers the within-call case `blocksLoaded` cannot: one render's batch can
        //    legitimately list the same tag several times.
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
