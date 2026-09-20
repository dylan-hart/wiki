import { onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { toMerged } from 'es-toolkit/object'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

/**
 * @param {object} opts
 * @param {string} opts.i18nPrefix The page's locale key stem -- `<prefix>.loadFailed`,
 *   `<prefix>.saveSuccess`, `<prefix>.saveFailed`, `<prefix>.refreshSuccess`, and the stem the
 *   server's `err.data.error` code is looked up under.
 * @param {object} [opts.keys] Per-message overrides for those four keys, for a page whose stem does
 *   not follow the convention.
 * @param {boolean} [opts.siteScoped] Whether this page edits one site (the default). A site-scoped
 *   page reloads when `adminStore.currentSiteId` changes, never fetches without one, and gates
 *   `onSavedCurrentSite` on it.
 * @param {boolean} [opts.overlay] Whether `load()` raises the full-screen overlay.
 * @param {() => object} [opts.defaults] The config every control binds to before anything is
 *   loaded. Given, the composable owns `state.config` and each load merges the fetched values over a
 *   fresh copy of it; omitted, there is no `state.config` and the page takes its loaded state
 *   through `onLoaded`.
 * @param {object} [opts.extraState] Further fields to seed `state` with, alongside the config.
 * @param {(siteId: string) => Promise<any>} opts.fetch Called with the administered site id; a page
 *   that is not site-scoped ignores it.
 * @param {(resp: any) => object} [opts.pick] The part of the response that is the config, when it is
 *   a sub-object. Defaults to the whole response. Called inside `load()`'s own `try`, so it MAY
 *   throw -- a response that does not hold what this page expected reads as a failed load rather
 *   than merging garbage into `state.config`. It may read the page's current state; it must not
 *   write any, which is `onLoaded`'s job.
 * @param {(resp: any) => void} [opts.onLoaded] Everything else the same response carries.
 * @param {(siteId: string, config: object) => Promise<any>} [opts.commit] Omitted by a page with
 *   nothing to save.
 * @param {(config: object) => any} [opts.onSaved] Awaited before `onSavedCurrentSite`.
 * @param {(config: object) => any} [opts.onSavedCurrentSite] Runs after a successful commit, but
 *   only when the site just saved is the one the admin's own browser is reading -- what makes an
 *   edit to the current site take effect on screen instead of only after a reload.
 * @returns {{ state: object, load: () => Promise<void>, save: () => Promise<boolean>,
 *   refresh: () => Promise<void> }}
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

  // -> The `currentSiteId` watcher re-fires `load()`, and a response can land well after it was
  //    sent, so applying one unconditionally would silently revert whatever the reader has since
  //    done to `state.config`/`extraState`. `requestGeneration` drops a response whose `load()` call
  //    has been superseded by a newer one; `snapshotTracked()` drops one whose tracked fields
  //    changed under it while its fetch was in flight, superseded or not.
  let requestGeneration = 0

  function snapshotTracked() {
    if (!defaults && !extraState) {
      return null
    }
    return JSON.stringify({
      ...(defaults ? { config: state.config } : {}),
      ...(extraState
        ? Object.fromEntries(Object.keys(extraState).map((key) => [key, state[key]]))
        : {})
    })
  }

  async function load() {
    if (siteScoped && !adminStore.currentSiteId) {
      return
    }
    state.loading++
    if (overlay) {
      loading.show()
    }
    const generation = ++requestGeneration
    const before = snapshotTracked()
    try {
      const resp = await fetch(adminStore.currentSiteId)
      // -> Anything else is a stale response: drop it rather than merge it over something newer.
      if (generation === requestGeneration && snapshotTracked() === before) {
        if (defaults) {
          state.config = toMerged(defaults(), (pick ? pick(resp) : resp) ?? {})
        }
        onLoaded?.(resp)
      }
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
        // -> The page's own wording for the server's error code where it has one, the server's own
        //    message where it does not.
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
