/**
 * Reader-facing strings a block renders into the page at runtime. A block runs in its own shadow
 * root, mounted well after the page itself has rendered, with no `useI18n()` composable to reach the
 * app's i18n instance from -- so it reads the page's locale off `document.documentElement.lang` (the
 * attribute `App.vue#applyLocale()` maintains) and fetches that locale's strings from the public
 * `GET /_api/locales/:code/strings`, with English as a second, equally-cached fallback layer.
 *
 * Not a second dictionary: every string resolved here lives in `backend/locales/en.json`, under
 * `blocks.<tag>.errors.*`.
 *
 * `t()` is for a call site that can await. `I18n`, a Lit reactive controller, is for a synchronous
 * `render()`: it serves the fallback until the fetch lands and then requests one update, so a block
 * neither blocks its first paint on a round trip nor stays silent until it completes.
 */

/** The promise, not the strings, so concurrent callers and blocks share one fetch per locale. */
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
 * `{}` for an unknown locale or a failed request -- never rejects, since "nothing to resolve" just
 * means every caller's own fallback carries the string.
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

/** Merged over English so a partial translation still resolves every key. */
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
 * Test-only: the module-level cache is deliberate in production, but would otherwise leak one test's
 * mocked response into the next.
 */
export function _resetI18nCache() {
  dictionaryPromises.clear()
}

/**
 * @param {string} key e.g. `blocks.qr-code.errors.tooLong`.
 * @param {string} fallback Used verbatim (after interpolation) when the key resolves nowhere.
 * @param {Record<string, string | number>} [params] Interpolated into `{name}` placeholders, in both
 *   the resolved string and `fallback` alike.
 */
export async function t(key, fallback, params) {
  const dict = await loadResolvedDictionary()
  return interpolate(key in dict ? dict[key] : fallback, params)
}

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

  /** Synchronous: `fallback`, interpolated, until the dictionary has loaded. */
  t(key, fallback, params) {
    const value = this._dict && key in this._dict ? this._dict[key] : fallback
    return interpolate(value, params)
  }
}
