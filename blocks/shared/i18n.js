/**
 * Locale strings, for blocks.
 *
 * A block sitting in page content is not part of the Vue app -- it has no access to the `vue-i18n`
 * instance `frontend/src/boot/i18n.js` sets up, and a reader-facing error string
 * (`blocks/block-youtube/component.js`'s "not the address of a YouTube video", `block-qr-code`'s
 * "too long to fit", `block-include`'s "no page at ...") can only be known at the moment the block
 * hits the failure, not ahead of time by whatever rendered the page. So this reads the page's own
 * locale the same way `theme.js` reads dark mode: off the document, rather than threaded down from
 * outside.
 *
 * The audit that filed this (`docs/audit-2026-08-24/ux-consistency.md` #10) named two shapes and
 * left the choice open. The one taken here: read `<html lang>` -- the same attribute
 * `App.vue#applyLocale` sets on every navigation -- and fetch that locale's strings from the public
 * `GET /_api/locales/:code/strings` endpoint (`backend/api/locales.ts`), the identical flat
 * key -> translated-string map `vue-i18n` loads for the app's own chrome, straight out of
 * `backend/locales/*.json`. No second dictionary: a key added under `blocks.<tag>.*` in `en.json` for
 * the metadata-localization half of this work (WP #1635's sibling) resolves here for free.
 *
 * Rejected alternative: the renderer resolving strings up front and passing them in as attributes.
 * That fits *static* block metadata -- a `label`/`hint`/`description` known before the block ever
 * runs, which is exactly what `BlockPickerOverlay.vue` and `BlockPropsForm.vue` do instead (see the
 * audit's part 1). It does not fit this file's job: a reader-facing error string is only known once
 * the block has tried and failed at runtime (an invalid URL, a QR payload that overflows, a page that
 * turned out not to exist), so there is no fixed set of strings a renderer could resolve ahead of
 * time and hand down as attributes -- the block has to be able to ask for an arbitrary key itself,
 * whenever it turns out to need one.
 *
 * One request per locale, shared by every block instance and every key any of them resolves -- the
 * same one-fetch-per-page-load cache `./icons.js`'s `fetchIcon` and `./config.js`'s `fetchSite` use,
 * for the same reason: a page with several blocks asking for strings should still only ask the server
 * once per locale.
 */

/** Locale code -> Promise<Record<string, string>>. Holds the promise so concurrent callers share it. */
const stringsCache = new Map()

function fetchStrings(locale) {
  if (!stringsCache.has(locale)) {
    stringsCache.set(
      locale,
      fetch(`/_api/locales/${encodeURIComponent(locale)}/strings`)
        .then((resp) => (resp.ok ? resp.json() : {}))
        .catch(() => ({}))
    )
  }
  return stringsCache.get(locale)
}

/**
 * The page's current locale code, read off `<html lang>` -- set by `App.vue#applyLocale` on boot and
 * on every navigation thereafter. Falls back to `en` when unset, which is what a bare document (a
 * static preview, a test harness) starts with before that code ever runs.
 *
 * @returns {string}
 */
export function currentLocale() {
  return document.documentElement.lang || 'en'
}

/**
 * Resolve `key` against the current locale's strings.
 *
 * `fallback` comes back unchanged -- not a thrown error, not an empty string -- whenever the key has
 * no translation: the locale is unknown to `getStrings` (which answers `[]` for one it doesn't
 * recognise), the key was never localized, or the request itself failed. An untranslated string is a
 * block quietly staying in English for one reader, not a block that breaks.
 *
 * @param {string} key A flat key into `backend/locales/*.json`, e.g. `blocks.youtube.invalidUrl`.
 * @param {string} fallback The English string to use when `key` has no translation.
 * @returns {Promise<string>}
 */
export async function t(key, fallback) {
  const strings = await fetchStrings(currentLocale())
  return (!Array.isArray(strings) && strings?.[key]) || fallback
}

/**
 * Test-only: forgets every cached locale fetch, so a new `t()` call issues a fresh request. Mirrors
 * `./config.js`'s `_resetBlockConfigCache` for the same reason -- the module-level cache is
 * deliberate in production but would otherwise leak one test's mocked response into the next.
 */
export function _resetLocaleStringsCache() {
  stringsCache.clear()
}
