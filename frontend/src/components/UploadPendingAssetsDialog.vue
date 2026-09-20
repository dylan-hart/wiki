<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="450px"
    persistent
    :aria-label="t(`editor.pendingAssetsUploading`)"
    @hide="onDialogHide">
    <w-card style="min-width: 350px">
      <w-card-section class="card-header">
        <w-icon name="tabler:cloud-upload" size="sm" class="me-2" />
        <span>{{ t(`editor.pendingAssetsUploading`) }}</span>
      </w-card-section>
      <w-card-section>
        <div class="p-4 text-center">
          <img src="/_assets/illustrations/undraw_upload.svg" style="width: 150px" alt="" />
        </div>
        <w-linear-progress indeterminate size="lg" rounded />
        <div class="mt-2 text-center text-caption">{{ state.current }} / {{ state.total }}</div>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`editor.pendingAssetsCancel`)"
          color="grey"
          padding="xs md"
          @click="cancelUpload" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { computed, onMounted, reactive } from 'vue'

import { useEditorStore } from '@/stores/editor'
import { useSiteStore } from '@/stores/site'
import { usePageStore } from '@/stores/page'
import { apiErrorMessage } from '@/helpers/apiError'
import { assetPath } from '@/helpers/assets'

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  current: 1,
  total: 1
})

let controller = null

function cancelUpload() {
  controller?.abort()
}

onMounted(async () => {
  // -> Snapshotted: the loop prunes `editorStore.pendingAssets` as each item lands, and iterating
  //    the live reactive array while removing from it is not something to rely on.
  const items = [...editorStore.pendingAssets]
  state.total = items.length ?? 0
  state.current = 0

  await new Promise((resolve) => setTimeout(resolve, 500))

  // -> One controller for the whole batch. The posts below run with `timeout: false` because ky's
  //    10s instance default is well under how long a max-size upload takes on a slow uplink, and a
  //    client-side abort there leaves the server finishing an upload nobody claims. An unbounded
  //    request needs a cancel escape hatch instead: Cancel aborts only the item in flight.
  controller = new AbortController()

  try {
    for (const item of items) {
      state.current++
      // -> The body is the file itself, not a multipart form; the locale is the server's to pick.
      const resp = await API_CLIENT.post(`sites/${siteStore.id}/assets`, {
        searchParams: {
          fileName: item.fileName,
          parentPath: pageStore.folderPath
        },
        headers: {
          'content-type': item.file.type || 'application/octet-stream'
        },
        body: item.file,
        timeout: false,
        signal: controller.signal
      }).json()
      // -> The stored name is not always the one asked for: the site's conflict behavior may
      //    replace the existing file or take the next free `name-1.ext`, so the content has to
      //    point at what the server reports.
      const storedPath = assetPath(resp?.asset?.folderPath, resp?.asset?.fileName)
      pageStore.content = pageStore.content.replaceAll(item.blobUrl, storedPath)
      /*
        Applied to the editor model and pruned per item, never batched to the end of the loop: a
        later failure would otherwise leave the editor holding blob URLs the next debounced flush
        writes back over, and re-upload the succeeded items as `name-1.ext` duplicates on retry.
      */
      EVENT_BUS.emit('reloadEditorContent', {
        replacements: [{ from: item.blobUrl, to: storedPath }]
      })
      editorStore.pendingAssets = editorStore.pendingAssets.filter((pending) => pending !== item)
      URL.revokeObjectURL(item.blobUrl)
    }
    onDialogOK()
  } catch (err) {
    // -> An abort surfaces as an AbortError DOMException from fetch, never a ky TimeoutError (no
    //    client-side timeout is set), and must read as a cancel rather than a server failure.
    if (err.name === 'AbortError') {
      notify({
        type: 'warning',
        message: t('editor.pendingAssetsCancelled')
      })
    } else {
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
    onDialogCancel()
  }
})
</script>
