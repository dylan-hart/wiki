import { computed, onScopeDispose, watch } from 'vue'
import { useRoute } from 'vue-router'

import { log } from '@/helpers/log'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

const STYLE_ID = 'page-styles'

/**
 * In the head, so these rules come after the app's own stylesheets and win a tie on order, and
 * unscoped: a page restyling the header or the sidebar for its own visit is why the field exists.
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
 * An external, same-origin module (`controllers/pageScripts.ts`), never inline: `script-src 'self'`
 * (`core/http/security.ts`) allows a same-origin file, but never an inline `<script>` or a
 * `new Function(...)` eval of the stored text.
 *
 * `v` is a cache-buster the server does not validate -- an edited page mints a fresh URL, which is
 * what lets the response come back `Cache-Control: immutable`.
 *
 * @param {{ id: string, updatedAt?: string }} page
 */
function pageScriptUrl(page) {
  return `/_pages/${page.id}/script.js?v=${encodeURIComponent(page.updatedAt ?? '')}`
}

/**
 * Blanked over an open editor, as for a locked page or a 404: an author previewing markup sees the
 * page's base behavior, not a rule or script they are mid-edit on and have not saved.
 */
export function usePageScripts() {
  const editorStore = useEditorStore()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const route = useRoute()

  /*
    Two checks, neither of which covers the other. `editorStore.isActive` is the Edit button opening
    the editor over a page whose URL never moves. The route test is for arriving at `/_edit/<page>`
    or `/_create` directly: the page lands in the store before the editor's own configuration does,
    and in that gap nothing but the URL says a readable-looking page is about to be written into.
  */
  const isEditing = computed(
    () =>
      editorStore.isActive || route.path.startsWith('/_edit') || route.path.startsWith('/_create')
  )

  const showing = computed(
    () =>
      siteStore.features.pageScripts &&
      Boolean(pageStore.id) &&
      !pageStore.notFound &&
      !pageStore.isLocked &&
      !isEditing.value
  )

  const activeCss = computed(() => (showing.value ? pageStore.scriptCss : ''))

  watch(activeCss, applyStyles, { immediate: true })

  /**
   * `''` when the page sets neither script: `controllers/pageScripts.ts` would answer an empty
   * module, so the import would be a wasted round trip.
   */
  const activeScriptUrl = computed(() => {
    if (!showing.value || (!pageStore.scriptJsLoad && !pageStore.scriptJsUnload)) {
      return ''
    }
    return pageScriptUrl(pageStore)
  })

  let currentModule = null
  // -> Bumped on every URL change, so an import resolving after a newer navigation can tell it is
  //    stale and skip `load()` for a page the reader has already left
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
        // -> Superseded while the import was in flight; nothing ran, so nothing needs unloading
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

  onScopeDispose(() => {
    applyStyles('')
    generation++
    runUnload(currentModule)
    currentModule = null
  })
}
