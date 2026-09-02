import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import {
  clearSiteImage,
  isAcceptedSiteImage,
  pickSiteImage,
  uploadSiteImage
} from '@/helpers/siteImages'

/**
 * Replacing or clearing one of a site's own images (`logo`, `favicon`, `loginBg`) from an admin
 * settings page.
 *
 * `helpers/siteImages.js` is the transport -- the picker, the accepted-type check and the two
 * requests. What sits around it was written out three times over two pages (`AdminGeneral.vue`'s
 * logo and favicon, `AdminLogin.vue`'s background): pick, refuse a type the endpoint would not take,
 * count the page's loading gauge up and back down, toast the outcome, flip the "this site has one"
 * flag and bump a cache-busting timestamp on the `<img>` src. Only the kind, that flag and the
 * locale keys ever differed, so this owns the orchestration and each page instantiates one per
 * image it offers.
 *
 * @param {'logo'|'favicon'|'loginBg'} kind Which of the site's images this instance manages.
 * @param {object} opts
 * @param {() => string} opts.siteId Reads the site being edited at call time -- a getter, not a
 *   value, since the admin can switch sites without this composable being re-created.
 * @param {import('vue').Ref<boolean>} opts.has Whether the site has an image of its own, i.e.
 *   whether there is anything to clear. Written on every successful upload and clear.
 * @param {string} opts.i18nPrefix The locale key stem for this image's four messages --
 *   `<prefix>UploadSuccess`, `<prefix>UploadFailed`, `<prefix>ClearSuccess`, `<prefix>ClearFailed`
 *   (e.g. `admin.general.logo`, `admin.login.bg`).
 * @param {import('vue').Ref<number>} opts.loading The page's own loading counter, raised for the
 *   duration of a request.
 * @param {string} [opts.invalidTypeKey] The caption shown when the picked file is a type the
 *   endpoint would refuse. Defaults to `<prefix>UploadInvalidType`; passed explicitly where one
 *   message is shared by several uploaders on the same page (`AdminGeneral.vue`).
 * @returns {{ upload: () => Promise<void>, clear: () => Promise<void>,
 *   timestamp: import('vue').Ref<string> }} `timestamp` is the query string that cache-busts the
 *   image's `<img>` src, and changes each time this image does.
 */
export function useSiteImage(kind, { siteId, has, i18nPrefix, loading, invalidTypeKey }) {
  const { t } = useI18n()

  const timestamp = ref(new Date().toISOString())

  async function upload() {
    const file = await pickSiteImage()
    if (!file) {
      return
    }
    if (!isAcceptedSiteImage(file)) {
      notify({
        type: 'negative',
        message: t(`${i18nPrefix}UploadFailed`),
        caption: t(invalidTypeKey ?? `${i18nPrefix}UploadInvalidType`)
      })
      return
    }
    loading.value++
    try {
      await uploadSiteImage(siteId(), kind, file)
      notify({
        type: 'positive',
        message: t(`${i18nPrefix}UploadSuccess`)
      })
      has.value = true
      timestamp.value = new Date().toISOString()
    } catch (err) {
      notify({
        type: 'negative',
        message: t(`${i18nPrefix}UploadFailed`),
        caption: apiErrorMessage(err)
      })
    }
    loading.value--
  }

  async function clear() {
    loading.value++
    try {
      await clearSiteImage(siteId(), kind)
      notify({
        type: 'positive',
        message: t(`${i18nPrefix}ClearSuccess`)
      })
      has.value = false
      timestamp.value = new Date().toISOString()
    } catch (err) {
      notify({
        type: 'negative',
        message: t(`${i18nPrefix}ClearFailed`),
        caption: apiErrorMessage(err)
      })
    }
    loading.value--
  }

  return { upload, clear, timestamp }
}
