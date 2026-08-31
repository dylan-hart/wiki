import { useI18n } from 'vue-i18n'

/**
 * Resolves a block's own metadata strings (`description`, and each prop's `label`/`hint`) through
 * i18n, for the two places they render inside otherwise fully-translated editor chrome:
 * `BlockPickerOverlay.vue` and `BlockPropsForm.vue`.
 *
 * The 223 strings a block's `static definition` carries are minted into `locales/en.json` under
 * `blocks.<tag>.description` / `blocks.<tag>.props.<name>.label` / `.hint` by
 * `backend/scripts/blockLocaleKeys.ts` — see that file for the key convention and the CI check that
 * keeps it in step with each block's `component.js`.
 *
 * A key that does not resolve falls back to the raw string carried on the block's own definition,
 * rather than to vue-i18n's own missing-key behaviour (rendering the dotted key path itself, e.g.
 * `blocks.openapi.description`) — `t()` alone cannot tell "this key legitimately isn't translated
 * yet" from "this key does not exist", so `te()` (translation-exists) is checked first. This also
 * covers the `fallbackLocale: 'en'` gap `docs/variances.md` records: a reader on a non-`en` locale
 * whose session never eager-loaded the `en` dictionary would otherwise see the raw key text instead
 * of the English original.
 */
export function useBlockLocale() {
  const { t, te } = useI18n()

  /**
   * @param {string | null | undefined} block A block's tag, e.g. `openapi` (`definition.block` /
   *   `SiteBlock.block`) — falsy for a custom block or one not yet selected, which has no
   *   `blocks.<tag>.*` namespace to resolve against.
   * @param {string} path Dotted path under `blocks.<tag>.`, e.g. `description` or
   *   `props.url.hint`.
   * @param {string} fallback The raw string off the definition, used verbatim when the key isn't
   *   there to translate.
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
