import { useI18n } from 'vue-i18n'

/**
 * Resolves a block's own metadata strings (`description`, and each prop's `label`/`hint`) through
 * i18n. `backend/scripts/blockLocaleKeys.ts` mints them into `locales/en.json` under
 * `blocks.<tag>.description` / `blocks.<tag>.props.<name>.label` / `.hint`.
 *
 * `te()` (translation-exists) is checked before `t()` because `t()` alone cannot tell "not
 * translated yet" from "no such key" and renders the dotted key path for both; an unresolved key
 * falls back to the raw string carried on the block's own definition instead. That also covers a
 * reader on a non-`en` locale whose `en` fallback dictionary has not finished loading.
 */
export function useBlockLocale() {
  const { t, te } = useI18n()

  /**
   * @param {string | null | undefined} block A block's tag, e.g. `openapi` — falsy for a custom
   *   block or one not yet selected, which has no `blocks.<tag>.*` namespace to resolve against.
   * @param {string} path Dotted path under `blocks.<tag>.`, e.g. `description` or `props.url.hint`.
   * @param {string} fallback The raw string off the definition.
   * @returns {string}
   */
  function blockText(block, path, fallback) {
    if (!block) {
      return fallback
    }
    const key = `blocks.${block}.${path}`
    return te(key) ? t(key) : fallback
  }

  return { blockText }
}
