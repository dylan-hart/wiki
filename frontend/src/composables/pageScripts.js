import { computed, onScopeDispose, watch } from 'vue'
import { useRoute } from 'vue-router'

import { log } from '@/helpers/log'

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
 * Where the JS half of a page's scripts lives (`controllers/pageScripts.ts`, OpenProject #3405) --
 * an external, same-origin module, never inline: `script-src 'self'` (the shipped default,
 * `core/http/security.ts`) allows a same-origin file like this one, but never an inline `<script>` or
 * a `new Function(...)` eval of the stored text.
 *
 * `v` is a cache-buster, not something the server validates -- it just makes an edited page mint a
 * fresh URL, which is what lets the response come back `Cache-Control: immutable`
 * (`controllers/pageScripts.ts`'s own doc comment). `updatedAt` is already on the page store for
 * every loaded page, so no extra round trip is needed to get one.
 *
 * @param {{ id: string, updatedAt?: string }} page
 */
function pageScriptUrl(page) {
  return `/_pages/${page.id}/script.js?v=${encodeURIComponent(page.updatedAt ?? '')}`
}

/**
 * The page's own CSS and JS (OpenProject #3389/#3404/#3405), applied to the page the reader is
 * looking at.
 *
 * A port of upstream 32a656e7b's `usePageScripts()`, CSP-aware rather than upstream's inline
 * `<style>`/`<script>` elements: `scriptCss` is still injected as a `<style>` (`style-src` already
 * carries `'unsafe-inline'` under the shipped CSP), but `scriptJsLoad`/`scriptJsUnload` are never
 * embedded as text on this page at all -- they are `import()`ed from the external, same-origin
 * module `controllers/pageScripts.ts` serves, and called explicitly, which is what lets a
 * `script-src 'self'` policy with no `'unsafe-inline'` allow them.
 *
 * Diverges from upstream's own composable on one point: upstream keeps CSS/JS live while the editor
 * is open over the page ("an author writing rules for a page wants to see them applied to it").
 * Cardinal blanks it there too -- Feature #3389's spec bullet is explicit ("Blanking: locked pages,
 * 404s and open editors never inject or execute") -- so an author previewing markup sees the page's
 * base behavior, not a rule or a script they are mid-edit on and have not saved.
 *
 * Reads `siteStore.features.pageScripts`: nothing is ever injected or imported while the site flag is
 * off, which is what makes it a real kill switch rather than something the author-facing dialog alone
 * enforces.
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

  /** Whether there is a page on screen, with something at all worth applying/running. */
  const showing = computed(
    () =>
      siteStore.features.pageScripts &&
      Boolean(pageStore.id) &&
      !pageStore.notFound &&
      !pageStore.isLocked &&
      !isEditing.value
  )

  /** Whether there is a page on screen, with CSS worth applying, at all. */
  const activeCss = computed(() => (showing.value ? pageStore.scriptCss : ''))

  watch(activeCss, applyStyles, { immediate: true })

  /**
   * The current page's script module URL, or `''` when there is nothing to import -- either nothing
   * is showing (see `showing` above) or the page set neither `scriptJsLoad` nor `scriptJsUnload`, in
   * which case `controllers/pageScripts.ts` would answer an empty module anyway and importing it
   * would be a wasted round trip.
   */
  const activeScriptUrl = computed(() => {
    if (!showing.value || (!pageStore.scriptJsLoad && !pageStore.scriptJsUnload)) {
      return ''
    }
    return pageScriptUrl(pageStore)
  })

  // -> The most recently imported module, so its `unload()` can be called before the next one's
  //    `load()` runs (or on teardown) -- `null` while nothing is currently loaded.
  let currentModule = null
  // -> Bumped on every `activeScriptUrl` change, so an import that resolves after a newer navigation
  //    has already moved on can tell it is stale and skip calling `load()` for a page the reader has
  //    since left, rather than racing the unload that already ran for it.
  let generation = 0

  function runUnload(mod) {
    try {
      mod?.unload?.()
    } catch (err) {
      log.warn('page', 'page script unload() threw', err)
    }
  }

  watch(
    activeScriptUrl,
    async (url) => {
      const thisGeneration = ++generation
      const previousModule = currentModule
      currentModule = null
      runUnload(previousModule)

      if (!url) {
        return
      }

      let mod
      try {
        mod = await import(/* @vite-ignore */ url)
      } catch (err) {
        log.warn('page', 'could not load the page script', err)
        return
      }
      if (thisGeneration !== generation) {
        // -> Superseded while the import was in flight; its own unload has already run above (or
        //    will, for whichever URL is current now), so this module is simply dropped unrun.
        return
      }
      currentModule = mod
      try {
        mod.load?.()
      } catch (err) {
        log.warn('page', 'page script load() threw', err)
      }
    },
    { immediate: true }
  )

  // -> The page view itself going away: the search screen, the admin area, a profile page
  onScopeDispose(() => {
    applyStyles('')
    generation++
    runUnload(currentModule)
    currentModule = null
  })
}
