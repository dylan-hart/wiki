import { computed, onMounted, reactive } from 'vue'

import { dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import ApiKeyCopyDialog from '@/components/ApiKeyCopyDialog.vue'
import { useAdminStore } from '@/stores/admin'

/**
 * Everything the two key-creation dialogs do identically — `ApiKeyCreateDialog.vue` (an
 * administrator issuing a key) and `ProfileApiKeyCreateDialog.vue` (a user issuing themselves a
 * personal access token).
 *
 * The two differ in their endpoint, their i18n vocabulary, the admin form's groups picker and the
 * profile form's two-column grid — which is why they stay two components rather than one with a
 * `mode` prop: their real-layout tests pin distinct grid widths, and merging them would make that
 * difference a runtime branch instead of two templates. What they share is all of this: the form
 * state, the fixed lifetimes, the site picker's "All Sites" entry, the classification grid's
 * all-checked default and what it sends, the name rules, and the create round trip that hands the
 * one-time secret to `ApiKeyCopyDialog`.
 *
 * @param {object} options
 * @param {string} options.endpoint `api-keys` or `users/profile/api-keys`.
 * @param {string} options.i18nPrefix `admin.api` or `profile.api`. Also the copy dialog's
 *   `labelPrefix`, which is what makes it say "API Key" on one screen and "Access Token" on the other.
 * @param {() => object|null} options.form Getter for the enclosing `WForm`, validated before sending.
 * @param {() => void} options.onOk Called once the copy dialog is dismissed — the dialog's own
 *   `onDialogOK`.
 * @param {object} [options.extraState] Merged into `state`, for a field only one form has.
 * @param {(state: object) => object} [options.extraJson] Extra fields for the create request.
 * @param {boolean} [options.silentLoadErrors] Fail soft on the site and classification-level
 *   fetches rather than raising a toast. The self-service form does: `GET /sites` needs
 *   `read:sites`/`access:admin`, which an ordinary user does not hold, so a failure there is the
 *   expected common case for that audience and degrades the picker to "All Sites" rather than being
 *   worth alarming them with.
 * @returns {{ state: object, expirations: Array, siteOptions: import('vue').ComputedRef,
 *   allowedClassifications: import('vue').ComputedRef, keyNameValidation: Array,
 *   loadSites: () => Promise<void>, create: () => Promise<void> }}
 */
export function useApiKeyCreateForm({
  endpoint,
  i18nPrefix,
  form,
  onOk,
  t,
  extraState,
  extraJson,
  silentLoadErrors = false
}) {
  const adminStore = useAdminStore()

  const state = reactive({
    keyName: '',
    keyExpiration: '90d',
    // -> Empty means unscoped (null on the wire): the key carries the full extent of what issued it,
    //    same as a key created before scoping existed. Anything picked here narrows it -- see each
    //    dialog's own field comment.
    keyScope: [],
    // -> null is the "All Sites" entry -- instance-wide, same as a key created before site-pinning
    //    existed.
    keySiteId: null,
    sites: [],
    loadingSites: false,
    // -> The checked ids of the classification checkbox grid, initialized to every level once
    //    `adminStore.classificationLevels` loads (see the mounted hook) -- all-checked, same as "No
    //    Limit" was before this existed. See `allowedClassifications` below for what actually gets sent.
    keyClassifications: [],
    loading: 0,
    ...extraState
  })

  const expirations = [
    { value: '30d', text: t(`${i18nPrefix}.expiration30d`) },
    { value: '90d', text: t(`${i18nPrefix}.expiration90d`) },
    { value: '180d', text: t(`${i18nPrefix}.expiration180d`) },
    { value: '1y', text: t(`${i18nPrefix}.expiration1y`) },
    { value: '3y', text: t(`${i18nPrefix}.expiration3y`) }
  ]

  /** The site select's own "All Sites" entry (`id: null`) is prepended -- see the field's template comment. */
  const siteOptions = computed(() => {
    return [{ id: null, title: t(`${i18nPrefix}.newKeySiteAllSites`) }, ...state.sites]
  })

  /**
   * What actually reaches the API (OpenProject #1205): `null` when every currently known level is
   * checked -- equivalent to the old "No Limit" default, and it stays that way against a level added
   * later too, exactly like a key created before this feature existed. Anything less than every level
   * checked is sent as the explicit array of checked ids, which only narrows.
   */
  const allowedClassifications = computed(() => {
    const allIds = adminStore.classificationLevels.map((level) => level.id)
    const isEveryLevelChecked = allIds.every((id) => state.keyClassifications.includes(id))
    return isEveryLevelChecked ? null : state.keyClassifications
  })

  const keyNameValidation = [
    (val) => val.length > 0 || t(`${i18nPrefix}.nameMissing`),
    (val) => /^[^<>"]+$/.test(val) || t(`${i18nPrefix}.nameInvalidChars`)
  ]

  /** Reports a load failure, unless this form was told to degrade silently. */
  function reportLoadFailure(err) {
    if (silentLoadErrors) {
      return
    }
    notify({
      type: 'negative',
      message: t(`${i18nPrefix}.loadFailed`),
      caption: err.message
    })
  }

  async function loadSites() {
    state.loading++
    state.loadingSites = true
    try {
      const resp = await API_CLIENT.get('sites').json()
      state.sites = resp ?? []
    } catch (err) {
      state.sites = []
      reportLoadFailure(err)
    }
    state.loadingSites = false
    state.loading--
  }

  async function create() {
    state.loading++
    try {
      const isFormValid = await form().validate(true)
      if (!isFormValid) {
        throw new Error(t(`${i18nPrefix}.createInvalidData`))
      }
      const resp = await API_CLIENT.post(endpoint, {
        json: {
          name: state.keyName,
          expiration: state.keyExpiration,
          ...extraJson?.(state),
          scope: state.keyScope.length > 0 ? state.keyScope : null,
          allowedClassifications: allowedClassifications.value,
          siteId: state.keySiteId
        }
      }).json()
      if (!resp?.key) {
        throw new Error(t('common.error.unexpected'))
      }
      notify({
        type: 'positive',
        message: t(`${i18nPrefix}.createSuccess`)
      })
      // -> The token exists only in this response, so hand it straight to the copy dialog -- the same
      //    generic dialog either form reuses, with its own vocabulary so it calls this an "API Key"
      //    or an "Access Token" as the screen does.
      dialog({
        component: ApiKeyCopyDialog,
        componentProps: {
          keyValue: resp.key,
          labelPrefix: i18nPrefix
        }
      }).onDismiss(() => {
        onOk()
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
    state.loading--
  }

  onMounted(async () => {
    loadSites()
    state.loading++
    try {
      await adminStore.fetchClassificationLevels()
    } catch (err) {
      reportLoadFailure(err)
    }
    // -> All-checked default (OpenProject #1205), equivalent to the old "No Limit" -- set only after
    //    the levels are known, since the checkbox grid has nothing to check before then.
    state.keyClassifications = adminStore.classificationLevels.map((level) => level.id)
    state.loading--
  })

  return {
    state,
    expirations,
    siteOptions,
    allowedClassifications,
    keyNameValidation,
    loadSites,
    create
  }
}
