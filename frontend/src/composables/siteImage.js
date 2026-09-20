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
 * `helpers/siteImages.js` stays the transport -- the picker, the accepted-type check and the two
 * requests; this owns the orchestration around them.
 *
 * @param {'logo'|'favicon'|'loginBg'} kind
 * @param {object} opts
 * @param {() => string} opts.siteId A getter, not a value: the admin can switch sites without this
 *   composable being re-created.
 * @param {import('vue').Ref<boolean>} opts.has
 * @param {string} opts.i18nPrefix The locale key stem for this image's four messages.
 * @param {import('vue').Ref<number>} opts.loading The page's own loading counter.
 * @param {string} [opts.invalidTypeKey] Passed where one message is shared by several uploaders on
 *   the same page.
 * @returns {{ upload: () => Promise<void>, clear: () => Promise<void>,
 *   timestamp: import('vue').Ref<string> }} `timestamp` cache-busts the image's `<img>` src.
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
