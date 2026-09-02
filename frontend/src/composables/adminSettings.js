import { onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { toMerged } from 'es-toolkit/object'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

/**
 * The load/save skeleton every admin settings page is built around.
 *
 * Sixteen `Admin*.vue` pages wrote out the same shape by hand: a `state.loading` gauge counted up and
 * back down around each request, the full-screen overlay shown and hidden with it, a negative toast
 * on a failed load, a positive one on a successful save and a negative one carrying the server's own
 * error code translated where the page has a message for it, and -- for the site-scoped pages -- a
 * watcher reloading everything when the admin switches site plus the mounted guard that starts it
 * off. Only the request and the payload ever really differed, and where anything else did it was
 * drift rather than design (a missing caption, a raw English fallback, an overlay shown by the
 * watcher instead of by `load()` itself).
 *
 * What a page keeps is what is genuinely its own: `defaultConfig()`, the requests, the payload
 * mapping and any action beyond loading and saving.
 *
 * @param {object} opts
 * @param {string} opts.i18nPrefix The page's locale key stem -- `<prefix>.loadFailed`,
 *   `<prefix>.saveSuccess`, `<prefix>.saveFailed`, `<prefix>.refreshSuccess`, and the stem the
 *   server's `err.data.error` code is looked up under.
 * @param {object} [opts.keys] Per-message overrides for the four keys above, for a page whose stem
 *   does not follow the convention (`AdminEditors.vue` says `fetchFailed`, not `loadFailed`).
 * @param {boolean} [opts.siteScoped] Whether this page edits one site (the default). A site-scoped
 *   page reloads when `adminStore.currentSiteId` changes, never fetches without one, and gates
 *   `onSavedCurrentSite` on it; a system-wide page (mail, security, flags) does none of that.
 * @param {boolean} [opts.overlay] Whether `load()` raises the full-screen overlay. True by default;
 *   the list-shaped pages (approvals, glossary, deleted pages) never showed one.
 * @param {() => object} [opts.defaults] The config every control binds to before anything is
 *   loaded. Given, the composable owns `state.config` and each load merges the fetched values over a
 *   fresh copy of it; omitted, there is no `state.config` and the page takes its loaded state
 *   through `onLoaded`.
 * @param {object} [opts.extraState] Further fields to seed `state` with -- the page-specific state
 *   that lives alongside the config (a provider list, a "this site has a background" flag).
 * @param {(siteId: string) => Promise<any>} opts.fetch The page's own read request(s). Called with
 *   the administered site id, which is `null` for a page that is not site-scoped.
 * @param {(resp: any) => object} [opts.pick] The part of the response that is the config, when it is
 *   a sub-object (`(site) => site.theme`). Defaults to the whole response. Called inside `load()`'s
 *   own `try`, so it MAY throw -- a response that does not hold what this page expected reads as a
 *   failed load and raises the load-failure toast, rather than merging garbage into `state.config`.
 *   It may also read the page's current state (`state`, a store), since it runs after the fetch
 *   resolved; it must not write any, which is `onLoaded`'s job.
 * @param {(resp: any) => void} [opts.onLoaded] Everything else the same response carries, for the
 *   state a page keeps outside its config.
 * @param {(siteId: string, config: object) => Promise<any>} [opts.commit] The page's own write
 *   request. A page with nothing to save (a listing, a read-only report) leaves it out.
 * @param {(config: object) => any} [opts.onSaved] Runs after a successful commit, awaited before the
 *   gate below.
 * @param {(config: object) => any} [opts.onSavedCurrentSite] Runs after a successful commit, but
 *   only when the site just saved is the one the admin's own browser is reading -- what makes an
 *   edit to the current site take effect on screen instead of only after a reload.
 * @returns {{ state: object, load: () => Promise<void>, save: () => Promise<boolean>,
 *   refresh: () => Promise<void> }} `save()` answers whether the commit went through, for the page
 *   that has something of its own to do only when it did.
 */
export function useAdminSettings({
  i18nPrefix,
  keys,
  siteScoped = true,
  overlay = true,
  defaults,
  extraState,
  fetch,
  pick,
  onLoaded,
  commit,
  onSaved,
  onSavedCurrentSite
}) {
  const { t } = useI18n()

  const adminStore = useAdminStore()
  const siteStore = useSiteStore()

  const messageKeys = {
    loadFailed: `${i18nPrefix}.loadFailed`,
    saveSuccess: `${i18nPrefix}.saveSuccess`,
    saveFailed: `${i18nPrefix}.saveFailed`,
    refreshSuccess: `${i18nPrefix}.refreshSuccess`,
    ...keys
  }

  const state = reactive({
    loading: 0,
    ...(defaults ? { config: defaults() } : {}),
    ...extraState
  })

  async function load() {
    // -> The guard the site-scoped pages spelled out in `onMounted` (and, in a few, at the top of
    //    `load()`): with no site chosen there is nothing to address a request to.
    if (siteScoped && !adminStore.currentSiteId) {
      return
    }
    state.loading++
    if (overlay) {
      loading.show()
    }
    try {
      const resp = await fetch(adminStore.currentSiteId)
      if (defaults) {
        state.config = toMerged(defaults(), (pick ? pick(resp) : resp) ?? {})
      }
      onLoaded?.(resp)
    } catch (err) {
      notify({
        type: 'negative',
        message: t(messageKeys.loadFailed),
        caption: apiErrorMessage(err)
      })
    }
    if (overlay) {
      loading.hide()
    }
    state.loading--
  }

  async function save() {
    state.loading++
    let saved = false
    try {
      await commit(adminStore.currentSiteId, state.config)
      notify({
        type: 'positive',
        message: t(messageKeys.saveSuccess)
      })
      await onSaved?.(state.config)
      if (!siteScoped || adminStore.currentSiteId === siteStore.id) {
        await onSavedCurrentSite?.(state.config)
      }
      saved = true
    } catch (err) {
      notify({
        type: 'negative',
        message: t(messageKeys.saveFailed),
        // -> The server's own error code where this page has a message for it, its message where it
        //    does not: `/_api` failures come back as `{ ok, error, statusCode, message }`.
        caption: t(
          `${i18nPrefix}.${err.data?.error}`,
          apiErrorMessage(err, t('common.error.unexpected'))
        )
      })
    }
    state.loading--
    return saved
  }

  async function refresh() {
    await load()
    notify({
      type: 'positive',
      message: t(messageKeys.refreshSuccess)
    })
  }

  if (siteScoped) {
    watch(() => adminStore.currentSiteId, load)
  }

  onMounted(load)

  return { state, load, save, refresh }
}
