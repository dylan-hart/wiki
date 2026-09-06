import { computed, reactive, ref } from 'vue'

/**
 * Reader text direction.
 *
 * The single source of truth is the `dir` attribute on `<html>`, written by `App.vue`'s
 * `applyDocumentLocale()` on every navigation -- not only once at boot: a reader moving between an
 * LTR page and an RTL one in the same session (any multi-locale wiki) flips it mid-app-lifetime,
 * with no remount of the surrounding layout to hang a read-once value off of. A module-level ref
 * mirrors it for the same reason `composables/dark.js` mirrors `body--dark`: setting an attribute on
 * an element outside the app is not itself reactive, and every caller has to see the same value.
 *
 * The `rtl` `applyDocumentLocale()` passes to `.set()` tracks the locale the URL itself addresses in
 * its own leading segment (`/ar/some/page`), validated against `siteStore.locales.active`, and falls
 * back to the reader's interface locale (`commonStore.locale`) on a URL that names none -- every
 * `/_`-prefixed route, and any unprefixed page path. Deriving it from the URL rather than from a
 * loaded page's own `isRTL` is what makes it hold for a destination with no page behind it at all
 * (OpenProject #2596), and matches the resolution
 * `backend/helpers/appShell.ts#resolveAppShellLocale` already performs server-side, so the
 * pre-hydration shell and the post-hydration document agree on a locale-prefixed URL rather than
 * flashing between them. `i18n.locale.value` is the separate axis that keeps following
 * `commonStore.locale`; `LocaleSelectorMenu.vue`'s header comment documents that same split from the
 * content-switcher's side, and `docs/decisions/lang-dir-contract.md` records the contract. This
 * composable itself is agnostic to which locale feeds it -- it just mirrors whatever `dir`
 * `applyDocumentLocale()` last set.
 *
 * Most of what "goes RTL" is plain CSS -- logical properties resolve against `dir` on their own, no
 * Vue involved. This exists for the minority that is NOT CSS: a `WMenu`/`WTooltip` `anchor`/`self`
 * pair, computed in JS (`helpers/directionalAnchor.js`), needs to know the direction to mirror
 * itself, and unlike a component that only lives for one editing session (`EditorMarkdown.vue`,
 * which reads `document.documentElement.dir` once at setup because switching locale mid-edit is not
 * a case it has to survive gracefully), a persistent layout component like `PageHeader.vue` is
 * mounted across navigations and must not go stale.
 */
const isRTL = ref(typeof document !== 'undefined' && document.documentElement.dir === 'rtl')

function apply(rtl) {
  isRTL.value = rtl === true
  document.documentElement.setAttribute('dir', isRTL.value ? 'rtl' : 'ltr')
}

export function useDirection() {
  return reactive({
    /** @type {boolean} */
    isRTL: computed(() => isRTL.value),

    /** @param {boolean} rtl */
    set(rtl) {
      apply(rtl)
    }
  })
}
