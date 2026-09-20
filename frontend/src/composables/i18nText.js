import { useI18n } from 'vue-i18n'

/**
 * Two situations need a fallback, not just a missing translation: `useI18n()` throws outright when
 * no vue-i18n plugin has been installed (a shared `W*` component mounted standalone in its own unit
 * test), and even with one installed the `en` fallback dictionary is eager-loaded fire-and-forget
 * rather than awaited, so a reader on another locale can briefly have neither. `useI18n()` answers
 * a missing key with the key itself, so stubbing `t` to do the same when there is no plugin lets
 * one check -- "did I get back what I asked for?" -- cover both cases.
 *
 * `params` is forwarded to `t(key, params)` for a message with named interpolation. Pass
 * already-interpolated text as `englishFallback` in that case, not a template: the fallback path
 * never goes through `t()`'s interpolation.
 */
export function useDictText() {
  let t
  try {
    ;({ t } = useI18n())
  } catch {
    t = (key) => key
  }

  return function dictText(key, englishFallback, params) {
    const resolved = t(key, params)
    return resolved === key ? englishFallback : resolved
  }
}
