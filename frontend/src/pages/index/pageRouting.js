import { nextTick } from 'vue'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { scrollToAnchorWhenReady } from '@/helpers/anchors'
import { apiErrorMessage } from '@/helpers/apiError'
import { collectBlocksToLoad } from '@/helpers/blockScan'
import { parseLocalePrefix } from '@/helpers/pagePaths'

import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * Stores are resolved per call rather than at module scope -- these run from a watcher, long after
 * the active pinia exists. `router` is passed in instead, since `useRouter()` needs the
 * component's own injection context.
 */

/**
 * `/_create/:editor`.
 *
 * @param {import('vue-router').RouteLocationNormalized} route
 * @param {object} ctx
 * @param {import('vue-router').Router} ctx.router
 * @param {(key: string) => string} ctx.t
 */
export async function enterCreateMode(route, { router, t }) {
  const pageStore = usePageStore()
  const userStore = useUserStore()

  if (!route.params.editor) {
    notify({
      type: 'negative',
      message: t(`editor.noEditorSpecified`)
    })
    return router.replace('/')
  }
  loading.show()
  const pageCreateArgs = { editor: route.params.editor, fromNavigate: true }
  if (route.query.path) {
    pageCreateArgs.path = route.query.path
  }
  if (route.query.locale) {
    pageCreateArgs.locale = route.query.locale
  }
  // -> `pageCreate` can reject (its own `fetchConfigs()` call is a network request); unguarded,
  //    that leaves the full-screen loading overlay up forever.
  try {
    await pageStore.pageCreate(pageCreateArgs)
    /*
      This route never reaches `loadPageForRoute`'s own permission fetch, so without this every
      page-permission-gated control reads as denied for the whole create session. `pageStore.path`/
      `.locale`, not `pageCreateArgs`: `pageCreate` is what resolves the actual target path -- a
      default `new-page` slug when the route carried none.
    */
    await userStore.fetchPagePermissions(pageStore.path, pageStore.locale)
  } catch (err) {
    notify({ type: 'negative', message: apiErrorMessage(err) })
    router.replace('/')
  } finally {
    loading.hide()
  }
}

/**
 * `/_edit/:pagePath`.
 *
 * @param {import('vue-router').RouteLocationNormalized} route
 * @param {object} ctx
 * @param {import('vue-router').Router} ctx.router
 */
export async function enterEditMode(route, { router }) {
  const pageStore = usePageStore()
  const userStore = useUserStore()

  if (!route.params.pagePath) {
    return router.replace('/')
  }
  loading.show()
  // -> `pageEdit` throws `ERR_PAGE_NOT_FOUND`/`ERR_PAGE_UNAUTHORIZED` for a bad path; unguarded,
  //    `/_edit/<bad-path>` strands the app behind the loading overlay forever.
  try {
    await pageStore.pageEdit({
      path: route.params.pagePath,
      locale: typeof route.query.locale === 'string' ? route.query.locale : undefined,
      fromNavigate: true
    })
    /*
      Same gap as `enterCreateMode`: this route never reaches `loadPageForRoute`'s own permission
      fetch, so an editor opened directly on `/_edit/:pagePath` (a bookmark, a reload while
      editing) would hold no page permissions at all. `pageStore.path`/`.locale` are the server's
      own normalized values off the page just loaded, not the raw route params.
    */
    await userStore.fetchPagePermissions(pageStore.path, pageStore.locale)
  } catch (err) {
    if (err.message === 'ERR_PAGE_UNAUTHORIZED') {
      router.replace('/_error/unauthorized')
    } else {
      notify({
        type: 'negative',
        message:
          err.message === 'ERR_PAGE_NOT_FOUND' ? 'This page does not exist.' : apiErrorMessage(err)
      })
      router.replace('/')
    }
  } finally {
    loading.hide()
  }
}

/**
 * @param {import('vue-router').RouteLocationNormalized} route
 * @param {number} generation This navigation's ticket from the view's own load counter, re-checked
 *   against `currentGeneration()` at each point a stale response could still do damage.
 * @param {object} ctx
 * @param {import('vue-router').Router} ctx.router
 * @param {object} ctx.state The view's reactive state bag -- `tocPanelOpen` is the one field read.
 * @param {{value: Element|null}} ctx.pageContents Ref to the rendered content element.
 * @param {() => void} ctx.scrollPageToTop
 * @param {() => number} ctx.currentGeneration
 */
export async function loadPageForRoute(
  route,
  generation,
  { router, state, pageContents, scrollPageToTop, currentGeneration }
) {
  const commonStore = useCommonStore()
  const editorStore = useEditorStore()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const newValue = route.path

  // -> The contents panel belongs to the page being left, so it goes with it
  state.tocPanelOpen = false
  scrollPageToTop()
  /*
    A locale-prefixed URL (`/fr/some/page`) is not a page path: `normalizePath`/`fastHash` in
    `stores/page.js` know nothing about locales and would hash a path matching no page at all. A
    first segment that is not one of the site's active locale codes is an ordinary path, and an
    unprefixed URL (a site with `locales.forcePrefix` off) falls back to the primary locale -- the
    same default the server uses for a lookup with no `locale` on it.
  */
  const parsedLocale = siteStore.useLocales
    ? parseLocalePrefix(
        newValue,
        siteStore.locales.active.map((l) => l.code)
      )
    : null
  const pagePath = parsedLocale?.path ?? newValue
  const pageLocale = parsedLocale?.locale ?? siteStore.locales.primary
  try {
    await pageStore.pageLoad({
      path: pagePath,
      locale: pageLocale,
      isStale: () => generation !== currentGeneration()
    })
    // -> A faster, later navigation already landed: `pageLoad` discarded its own response, and
    //    none of what follows belongs to the page actually on screen either.
    if (generation !== currentGeneration()) {
      return
    }
    if (editorStore.isActive) {
      /*
        `mode` describes the editor that was open, so it has to go back with it. Left on `create`,
        `pageSave` POSTs a new page instead of patching the one on screen, the header offers Create
        Page where Save Changes belongs, and Discard throws away a property edit as though it were
        an abandoned draft.
      */
      editorStore.$patch({
        isActive: false,
        mode: 'edit'
      })
    }
    // -> `collectBlocksToLoad` tolerates a missing content element: a locked page draws its lock
    //    screen in place of the article, so there is nothing to scan.
    nextTick(() => {
      // -> Checked again: a further navigation can land in the gap `nextTick` defers across.
      if (generation !== currentGeneration()) {
        return
      }
      commonStore.loadBlocks(collectBlocksToLoad(pageContents.value, siteStore.blocksIndex))
      /*
        The browser tried the URL's heading the moment it had the document, long before this render
        existed, so a link to `#a-heading` lands at the top of the page. Done here rather than on
        mount because a route change within the app renders a new page the same way.
      */
      scrollToAnchorWhenReady(route.hash)
    })
  } catch (err) {
    // -> A stale ERR_PAGE_NOT_FOUND would call `pageStore.pageNotFound` below and blank the store
    //    for whatever page a faster, later navigation already landed on.
    if (generation !== currentGeneration()) {
      return
    }
    if (err.message === 'ERR_PAGE_NOT_FOUND') {
      if (newValue === '/') {
        if (!userStore.authenticated) {
          router.push('/login')
        } else {
          /*
            The permissions have to be asked for on their own here: `write:pages` is a page-rule
            permission, so a cold load's empty `pagePermissions` can only ever answer this
            truthfully for `manage:system`. Asked at `'home'`, not `pagePath` (which is just `/`
            here): page rules are written against real page paths, and `'home'` is what the server
            treats the root as everywhere else (`backend/api/pages/read.ts`'s `path || 'home'`).
          */
          await userStore.fetchPagePermissions('home', pageLocale)
          if (userStore.can('write:pages')) {
            siteStore.overlay = 'Welcome'
          } else {
            // -> Not `/_error/unauthorized`: a reader who may not write here is not wrong about
            //    the page -- it genuinely doesn't exist.
            pageStore.pageNotFound({ path: 'home' })
          }
        }
      } else {
        /*
          -> Not a notification over the page the reader came from: that page is still on screen
          behind it, at a URL that is not its own. The view draws the missing page instead.

          `pagePath`/`pageLocale`, not the raw locale-prefixed `newValue` (`fr/some/page`), which is
          not a page path at all: the prefix would reach the create screen's display path, the
          permission probe below and (via `pageStore.path`) `createPage`'s POST.
        */
        pageStore.pageNotFound({ path: pagePath })
        // -> No page to carry the permissions here, and the screen about to be drawn offers to
        //    create one, which is a permission question.
        await userStore.fetchPagePermissions(pagePath, pageLocale)
      }
    } else if (err.message === 'ERR_PAGE_UNAUTHORIZED') {
      // -> `replace`, so the back button leaves the wiki rather than bouncing off the same refusal
      router.replace('/_error/unauthorized')
    } else {
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
  }
}
