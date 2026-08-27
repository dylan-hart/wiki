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
    desiredLocale: localStorage.getItem('locale'),
    blocksLoaded: []
  }),
  getters: {},
  actions: {
    async fetchLocaleStrings(locale) {
      try {
        return API_CLIENT.get(`locales/${locale}/strings`).json()
      } catch (err) {
        console.warn(err)
        throw err
      }
    },
    setLocale(locale) {
      this.$patch({
        locale,
        desiredLocale: locale
      })
      localStorage.setItem('locale', locale)
    },
    /**
     * Import one block entry's compiled component and record it as loaded. Split out from
     * `loadBlocks()` below so its per-tag dedupe can be verified with a stubbed import that actually
     * resolves — nothing under `/_blocks/` is really served in a unit test, so a real `import()`
     * always rejects, which would leave `blocksLoaded` untouched no matter how many callers raced.
     */
    async _importBlock(entry, siteId) {
      await import(/* @vite-ignore */ blockImportUrl(entry, siteId))
      this.blocksLoaded.push(entry.tag)
    },
    /**
     * @param blocks Tags to load, each either a bare string (a built-in) or `{ tag, isCustom, id }`
     *   (a record from `sites/:siteId/blocks` -- see `normalizeBlockEntry()`).
     *
     * Concurrency-safe per tag: `toLoad`'s `!blocksLoaded.includes(...)` filter only screens out a
     * tag that has ALREADY finished loading -- two calls racing for the same not-yet-loaded tag would
     * otherwise both pass it and both `import()`, each appending the tag to `blocksLoaded` once it
     * resolves (OpenProject #1734). `this._pendingImports` closes that gap: the first caller for a
     * given tag stores its in-flight promise there, every other caller (this call's own remaining
     * entries included, and any later call before the import settles) awaits that same promise
     * instead of starting a second `import()`. Removed again once settled -- success or failure --
     * so a later call for a tag whose import failed still gets a real retry rather than being stuck
     * on a rejected promise forever.
     */
    async loadBlocks(blocks = []) {
      const siteStore = useSiteStore()
      this._pendingImports ??= new Map()
      const entries = blocks.map(normalizeBlockEntry)
      const toLoad = entries.filter((entry) => !this.blocksLoaded.includes(entry.tag))
      await Promise.all(
        toLoad.map((entry) => {
          if (!this._pendingImports.has(entry.tag)) {
            this._pendingImports.set(
              entry.tag,
              this._importBlock(entry, siteStore.id)
                .catch((err) => {
                  console.warn(`Failed to load ${entry.tag}: ${err.message}`)
                })
                .finally(() => {
                  this._pendingImports.delete(entry.tag)
                })
            )
          }
          return this._pendingImports.get(entry.tag)
        })
      )
    }
  }
})
