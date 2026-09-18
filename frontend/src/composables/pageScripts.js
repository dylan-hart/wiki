import { computed, onScopeDispose, watch } from 'vue'
import { useRoute } from 'vue-router'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/**
 * The style element carrying the current page's CSS. One per document: only one page is on screen at
 * a time, so this is replaced rather than added to, and a page without CSS has none at all.
 */
const STYLE_ID = 'page-styles'

/**
 * Apply the page's CSS, replacing whatever the previous page had.
 *
 * Appended to the head, so these rules come after the app's own stylesheets and win a tie on order --
 * which is what a per-page override is for. It is not scoped to the article: the field is documented
 * as "CSS rules to add to the page", and a page that wants to restyle the header or the sidebar for
 * its own visit is the reason it exists.
 *
 * @param {string} css
 */
function applyStyles(css) {
  const existing = document.getElementById(STYLE_ID)
  if (!css?.trim()) {
    existing?.remove()
    return
  }
  const el = existing ?? document.createElement('style')
  el.id = STYLE_ID
  el.textContent = css
  if (!existing) {
    document.head.appendChild(el)
  }
}

/**
 * The page's own CSS (OpenProject #3389/#3404), applied to the page the reader is looking at.
 *
 * A CSS-only port of upstream 32a656e7b's `usePageScripts()` -- the Javascript half (`scriptJsLoad`/
 * `scriptJsUnload`) is a dependent Task (#3405), which needs the CSP-aware external-file mechanism
 * `docs/decisions/` records for Feature #3389; `scriptCss` needs none of that, since `style-src`
 * already carries `'unsafe-inline'` under the shipped CSP.
 *
 * Diverges from upstream's own composable on one point: upstream keeps CSS live while the editor is
 * open over the page ("an author writing rules for a page wants to see them applied to it"). Cardinal
 * blanks it there too -- Feature #3389's spec bullet is explicit ("Blanking: locked pages, 404s and
 * open editors never inject or execute") -- so an author previewing markup sees the page's base
 * styling, not a rule they are mid-edit on and have not saved.
 *
 * Reads `siteStore.features.pageScripts`: nothing is ever injected while the site flag is off, which
 * is what makes it a real kill switch rather than something the author-facing dialog alone enforces.
 */
export function usePageScripts() {
  const editorStore = useEditorStore()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const route = useRoute()

  /*
    Whether an editor is open (or about to be) over whatever page is in the store right now.

    Two checks, neither of which covers the other -- the same gap upstream's own composable
    documents for `isEditing`. `editorStore.isActive` is the Edit button opening the editor over a
    page whose URL never moves. The route test is for arriving at `/_edit/<page>` or `/_create`
    directly: the page is fetched into the store (or `pageNotFound()`/`pageCreate()` resets it)
    before the editor's own configuration is, and in that gap nothing but the URL says a page that
    looks readable is actually about to be written into rather than shown.
  */
  const isEditing = computed(
    () =>
      editorStore.isActive || route.path.startsWith('/_edit') || route.path.startsWith('/_create')
  )

  /** Whether there is a page on screen, with CSS worth applying, at all. */
  const activeCss = computed(() => {
    if (!siteStore.features.pageScripts) {
      return ''
    }
    if (!pageStore.id || pageStore.notFound || pageStore.isLocked || isEditing.value) {
      return ''
    }
    return pageStore.scriptCss
  })

  watch(activeCss, applyStyles, { immediate: true })

  // -> The page view itself going away: the search screen, the admin area, a profile page
  onScopeDispose(() => {
    applyStyles('')
  })
}
