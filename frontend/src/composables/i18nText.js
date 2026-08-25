import { useI18n } from 'vue-i18n'

/**
 * Resolves a `common.*` dictionary key to a translated string, falling back to a literal English
 * default when the key does not resolve.
 *
 * Two situations both need this, not just missing translations: `useI18n()` itself throws when no
 * vue-i18n plugin has been installed at all -- true of most of the shared `W*` library's own unit
 * tests, which mount a component standalone with no app-level plugin -- and even with a plugin
 * installed, `fallbackLocale: 'en'` is configured but its dictionary is never guaranteed loaded (see
 * `docs/variances.md`'s `App.vue#applyLocale()` note): a reader on a non-`en` locale can have neither
 * that locale's nor English's messages for a given key. `useI18n()`'s composition API already answers
 * a missing key with the key itself (with warnings silenced), so a stub `t` that does the same when no
 * plugin exists at all lets one check -- "did I get back what I asked for?" -- cover both cases alike.
 *
 * The prop stays the way a call site overrides either default; this only resolves what a component
 * falls back to when the caller does not pass one.
 */
export function useDictText() {
  let t
  try {
    ;({ t } = useI18n())
  } catch {
    t = (key) => key
  }

  return function dictText(key, englishFallback) {
    const resolved = t(key)
    return resolved === key ? englishFallback : resolved
  }
}
