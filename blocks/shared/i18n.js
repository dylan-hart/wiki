/**
 * Reader-facing string resolution, for blocks -- part 2 of localizing `blocks/` (OpenProject #1624).
 * Part 1 (#1628/#1631) covers the metadata a block declares on its own `static definition`, resolved
 * on the frontend where `blocks.<tag>.*` is already loaded into the app's own i18n instance. This
 * file is for the other half: a handful of *reader-facing* error strings a block renders into the
 * page body at runtime (`block-youtube`, `block-qr-code`, `block-include` today), which a block has
 * no way to reach that instance from -- it runs in its own shadow root, mounted well after the page
 * itself has rendered, with no `useI18n()` composable to call.
 *
 * Shape chosen: read the page's locale off `document.documentElement.lang` -- the same attribute
 * `App.vue#applyLocale()` sets on every navigation, and the same "read a DOM signal `../shared/theme.js`
 * already reads `body--dark` off" pattern this directory's other files use -- and fetch that locale's
 * strings from the public `GET /_api/locales/:code/strings` endpoint (`publicAccess: true`,
 * `backend/api/locales.ts`), cached for the page the same way `./config.js`'s `getBlockConfig` and
 * `./site.js`'s `getSiteId` cache their own single fetch. English is a second, equally-cached fetch,
 * used only as the resolver's own fallback layer when the page's locale is missing a key -- covering
 * the `fallbackLocale: 'en'` gap `docs/variances.md` records for the app's own vue-i18n instance
 * (a non-`en` session that never eager-loaded `en` messages). Do not introduce a second dictionary:
 * every string resolved here still lives in `backend/locales/en.json`, under `blocks.<tag>.errors.*`.
 *
 * Rejected alternative: having the renderer (`backend/controllers/render.ts`) pass resolved strings
 * in as attributes. That would mean the render path enumerating, ahead of time, every runtime error a
 * block *might* need to show -- a vocabulary that is a block's own to define and grow, not the page
 * renderer's to anticipate -- and would grow the render payload by every future block's error set
 * whether or not that block, or that error, ever fires on a given page. A fetch-and-cache resolver is
 * also directly consistent with the rest of `blocks/shared/`, which already treats "ask the backend
 * for what a reader's browser cannot otherwise reach" as the normal shape for cross-block data.
 *
 * Two ways to call it. `t(key, fallback, params)` is async, for a lifecycle method already awaiting
 * something else (`block-include`'s `_loadNestedBlocks`, `block-qr-code`'s render pass). `I18n`, a
 * Lit reactive controller in the same shape as `./theme.js`'s `DarkMode`, is for a *synchronous*
 * `render()` call site (`block-youtube`'s invalid-URL message): its own `.t()` returns `fallback`
 * (interpolated the same way) until the fetch resolves, then calls `host.requestUpdate()` exactly
 * once so the real string appears on the next paint -- a block never has to choose between blocking
 * its first render on a network round trip and never explaining itself to a reader before that.
 */

/** One shared cache entry per locale: the promise, so concurrent callers/blocks share one fetch. */
const dictionaryPromises = new Map()

function currentLocale() {
  return document.documentElement.lang || 'en'
}

function fetchStrings(locale) {
  return fetch(`/_api/locales/${locale}/strings`)
    .then((resp) => (resp.ok ? resp.json() : null))
    .catch(() => null)
}

/**
 * @param {string} locale
 * @returns {Promise<Record<string, string>>} `{}` for an unknown locale or a failed request -- never
 *   rejects, since "nothing to resolve" just means every caller's own fallback carries it.
 */
function loadDictionary(locale) {
  if (!dictionaryPromises.has(locale)) {
    dictionaryPromises.set(
      locale,
      fetchStrings(locale).then((strings) => (strings && !Array.isArray(strings) ? strings : {}))
    )
  }
  return dictionaryPromises.get(locale)
}

/** The page's locale dictionary, merged over English so a partial translation still resolves. */
async function loadResolvedDictionary() {
  const locale = currentLocale()
  const [en, own] = await Promise.all([
    loadDictionary('en'),
    locale === 'en' ? Promise.resolve({}) : loadDictionary(locale)
  ])
  return { ...en, ...own }
}

function interpolate(str, params) {
  if (!params) {
    return str
  }
  return str.replaceAll(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match
  )
}

/**
 * Test-only: forgets every cached fetch, so a new call issues a fresh request. Mirrors `./site.js`'s
 * `_resetSiteCache` for the same reason -- the module-level cache is deliberate in production but
 * would otherwise leak one test's mocked response into the next.
 */
export function _resetI18nCache() {
  dictionaryPromises.clear()
}

/**
 * Resolve one key against the page's locale (falling back to English, then to `fallback`), for a
 * caller that can await it -- an async lifecycle method, not a synchronous `render()`.
 *
 * @param {string} key e.g. `blocks.qr-code.errors.tooLong`.
 * @param {string} fallback Used verbatim (after interpolation) when the key resolves nowhere.
 * @param {Record<string, string | number>} [params] Interpolated into `{name}` placeholders, in both
 *   the resolved string and `fallback` alike.
 * @returns {Promise<string>}
 */
export async function t(key, fallback, params) {
  const dict = await loadResolvedDictionary()
  return interpolate(key in dict ? dict[key] : fallback, params)
}

/**
 * A Lit reactive controller resolving strings for one host -- see the file header for why this
 * shape exists alongside the plain async `t()` above, and `./theme.js`'s `DarkMode` for the pattern
 * it mirrors.
 */
export class I18n {
  /** @param {import('lit').ReactiveElement} host */
  constructor(host) {
    this.host = host
    this._dict = null
    host.addController(this)
  }

  hostConnected() {
    loadResolvedDictionary().then((dict) => {
      this._dict = dict
      this.host.requestUpdate()
    })
  }

  /**
   * Synchronous -- safe to call directly inside `render()`. Returns `fallback` (interpolated) until
   * the dictionary has loaded, then the resolved string once it has.
   *
   * @param {string} key
   * @param {string} fallback
   * @param {Record<string, string | number>} [params]
   * @returns {string}
   */
  t(key, fallback, params) {
    const value = this._dict && key in this._dict ? this._dict[key] : fallback
    return interpolate(value, params)
  }
}
