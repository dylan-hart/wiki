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
 * The three independent branches of `Index.vue`'s `route.path` watcher, one function each.
 *
 * They were a single 263-line callback; nothing about them was shared beyond the watcher itself, and
 * each ends by returning out of it. The watcher keeps the dispatch (and the `ignoreRouteChange` and
 * `/_`-prefix guards, which are about the watcher rather than about any one branch); everything a
 * branch then does lives here.
 *
 * Stores are resolved per call rather than at module scope, the way `helpers/datetime.js` already
 * does it -- these run from a watcher, long after the active pinia exists. `router` is passed in
 * instead, since `useRouter()` needs the component's own injection context.
 */

/**
 * `/_create/:editor` -- open the editor on a page that does not exist yet.
 *
 * @param {import('vue-router').RouteLocationNormalized} route The current route.
 * @param {object} ctx
 * @param {import('vue-router').Router} ctx.router
 * @param {(key: string) => string} ctx.t The view's `useI18n()` translator.
 */
export async function enterCreateMode(route, { router, t }) {
  const pageStore = usePageStore()

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
  // -> Unlike the plain page-load branch below (whose own catch handles every error this store
  //    can throw), this had none at all -- `pageCreate` can reject (its own `fetchConfigs()` call
  //    is a network request), which left the full-screen loading overlay up forever with the
  //    error only in the console (OpenProject #947).
  try {
    await pageStore.pageCreate(pageCreateArgs)
  } catch (err) {
    notify({ type: 'negative', message: apiErrorMessage(err) })
    router.replace('/')
  } finally {
    loading.hide()
  }
}

/**
 * `/_edit/:pagePath` -- open the editor on a page that already exists.
 *
 * @param {import('vue-router').RouteLocationNormalized} route The current route.
 * @param {object} ctx
 * @param {import('vue-router').Router} ctx.router
 */
export async function enterEditMode(route, { router }) {
  const pageStore = usePageStore()

  if (!route.params.pagePath) {
    return router.replace('/')
  }
  loading.show()
  // -> `pageEdit` throws `ERR_PAGE_NOT_FOUND`/`ERR_PAGE_UNAUTHORIZED` for a bad path (it calls
  //    `pageLoad` internally, the same one the plain page-load branch below guards) -- left
  //    unguarded here, `/_edit/<bad-path>` stranded the app behind the loading overlay forever
  //    (OpenProject #947).
  try {
    await pageStore.pageEdit({
      path: route.params.pagePath,
      locale: typeof route.query.locale === 'string' ? route.query.locale : undefined,
      fromNavigate: true
    })
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
 * An ordinary page path -- load the page and settle everything that follows it landing.
 *
 * @param {import('vue-router').RouteLocationNormalized} route The current route.
 * @param {number} generation This navigation's ticket from the view's own load counter, checked
 *   against `currentGeneration()` at each point a stale response could still do damage.
 * @param {object} ctx
 * @param {import('vue-router').Router} ctx.router
 * @param {object} ctx.state The view's reactive state bag -- `tocPanelOpen` is the one field read.
 * @param {{value: Element|null}} ctx.pageContents Ref to the rendered content element.
 * @param {() => void} ctx.scrollPageToTop
 * @param {() => number} ctx.currentGeneration The view's live load counter.
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

  // -> Load Page. The contents panel belongs to the page being left, so it goes with it
  state.tocPanelOpen = false
  scrollPageToTop()
  /*
    A locale-prefixed URL (`/fr/some/page`) and its page path (`some/page`) are not the same string:
    the segment is not part of what a page is addressed by, so it has to come off before hashing --
    see `normalizePath`/`fastHash` in `stores/page.js`, which know nothing about locales and would
    otherwise hash a path that matches no page at all. A first segment that is not one of the site's
    active locale codes is an ordinary path rather than a locale (`parseLocalePrefix` returns null),
    and one that IS active but simply absent -- a site with `locales.forcePrefix` off leaves its
    primary locale unprefixed -- both fall back to the primary locale, same default the server uses
    for a lookup with no `locale` on it.
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
    // -> A faster, later navigation already landed while this one was still in flight -- `pageLoad`
    //    already discarded its own response (see its own `isStale` check), and none of what follows
    //    here -- the editor-exit patch, the block-loading scan, the anchor scroll -- belongs to the
    //    page actually on screen either.
    if (generation !== currentGeneration()) {
      return
    }
    if (editorStore.isActive) {
      /*
        Walking away from the editor closes it, and `mode` describes the editor that was open — so
        it has to go back with it. Left on `create`, it goes on claiming a page is being written
        long after the reader has moved on to reading one, and everything that asks gets the wrong
        answer: `pageSave` POSTs a new page instead of patching the one on screen, the header
        offers Create Page where Save Changes belongs, and Discard throws away a property edit as
        though it were an abandoned draft — putting the welcome screen over a wiki that has a home
        page.
      */
      editorStore.$patch({
        isActive: false,
        mode: 'edit'
      })
    }
    // -> Load Blocks. `collectBlocksToLoad` tolerates a missing content element, because a locked
    //    page draws its lock screen in place of the article -- so there is nothing to scan.
    nextTick(() => {
      // -> Checked again here, not just above: `nextTick` defers to the next DOM update cycle, and
      //    a further navigation can land in the gap between the check above and this callback
      //    actually running.
      if (generation !== currentGeneration()) {
        return
      }
      commonStore.loadBlocks(collectBlocksToLoad(pageContents.value, siteStore.blocksIndex))
      /*
        Then the heading in the URL, if there is one. The browser tried it the moment it had the
        document, which was long before this render existed, so nothing happened — following a link
        to `#a-heading` left the reader at the top of the page. Done here rather than on mount
        because a route change within the app renders a new page the same way.
      */
      scrollToAnchorWhenReady(route.hash)
    })
  } catch (err) {
    // -> Worse than the success branch above if left unguarded: a stale ERR_PAGE_NOT_FOUND would
    //    call `pageStore.pageNotFound` below and blank the store for whatever page a faster, later
    //    navigation already landed on.
    if (generation !== currentGeneration()) {
      return
    }
    if (err.message === 'ERR_PAGE_NOT_FOUND') {
      if (newValue === '/') {
        if (!userStore.authenticated) {
          router.push('/login')
        } else {
          /*
            The one place the page permissions have to be asked for on their own -- same as the
            non-root branch below, and for the same reason: `write:pages` is a page-rule
            permission, so a cold load's empty `pagePermissions` can only ever answer this
            truthfully for `manage:system`. Asked at `'home'`, not `pagePath` (which is just `/`
            here): page rules are written against real page paths, and `'home'` is what the server
            already treats the root as everywhere else (e.g. `backend/api/pages/read.ts`'s own
            `path || 'home'`). OpenProject #2063.
          */
          await userStore.fetchPagePermissions('home', pageLocale)
          if (userStore.can('write:pages')) {
            siteStore.overlay = 'Welcome'
          } else {
            // -> Same missing-page placeholder the non-root branch below draws, not
            //    `/_error/unauthorized`: a reader who may not write here is not wrong about the
            //    page -- it genuinely doesn't exist -- so this is what tells them that, truthfully.
            pageStore.pageNotFound({ path: 'home' })
          }
        }
      } else {
        /*
          -> Not a notification over the page the reader came from: that page is still on screen
          behind it, at a URL that is not its own. The view draws the missing page instead.

          `pagePath`/`pageLocale` above are the (path, locale) pair with the locale prefix already
          stripped off -- `newValue` is still the raw, locale-prefixed route path (`fr/some/page`),
          which is not a page path at all. Using it here used to bake the prefix into the create
          screen's display path, ask the permission probe about a path no rule is ever written
          against, and (via `pageStore.path`, below) into `createPage`'s POST -- see bug #949.
        */
        pageStore.pageNotFound({ path: pagePath })
        /*
          The one place the page permissions have to be asked for on their own: everywhere else they
          arrive with the page, and here there is no page to carry them — while the screen about to
          be drawn offers to create one, which is a permission question.
        */
        await userStore.fetchPagePermissions(pagePath, pageLocale)
      }
    } else if (err.message === 'ERR_PAGE_UNAUTHORIZED') {
      // -> `replace`, so the back button leaves the wiki the way it came rather than bouncing off
      //    the same refusal again
      router.replace('/_error/unauthorized')
    } else {
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
  }
}
