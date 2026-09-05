<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="450px"
    persistent
    :aria-label="t(`editor.pendingAssetsUploading`)"
    @hide="onDialogHide">
    <w-card style="min-width: 350px">
      <w-card-section class="card-header">
        <w-icon name="cardinal:upload" size="sm" class="me-2" />
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

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// STORES

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  current: 1,
  total: 1
})

/**
 * The batch's `AbortController`, created once `onMounted` starts the upload loop. `null` beforehand
 * (nothing to cancel yet), so `cancelUpload` below has to guard against being clicked in that window.
 */
let controller = null

/** Cancels whichever item is currently in flight -- the loop's own `catch` reports it distinctly. */
function cancelUpload() {
  controller?.abort()
}

// MOUNTED

onMounted(async () => {
  // -> Snapshotted once: the loop below prunes `editorStore.pendingAssets` as each item lands, and
  //    iterating the live (reactive) array while removing from it out from under itself is exactly
  //    the kind of thing to not rely on.
  const items = [...editorStore.pendingAssets]
  state.total = items.length ?? 0
  state.current = 0

  await new Promise((resolve) => setTimeout(resolve, 500))

  // -> A single controller for the whole batch: the file is posted with `timeout: false` below
  //    because ky's 10s instance default (`boot/api.js`) is well under how long a 25MB upload
  //    (`MAX_IMPORT_SIZE`, backend/models/import.ts) can take on a slow uplink -- the client used to
  //    abort with a TimeoutError while the server finished the upload anyway, leaving the item stuck
  //    in `pendingAssets` to re-upload as a `name-1.ext` duplicate on retry (OpenProject #945). An
  //    unbounded request needs its own cancel escape hatch instead, which is what the Cancel button
  //    triggers -- aborting only the item currently in flight; anything already uploaded this batch
  //    stays applied and pruned (see the pruning comment further down).
  controller = new AbortController()

  try {
    for (const item of items) {
      state.current++
      // -> The body is the file itself rather than a multipart form, and the locale is left to the
      //    server, which uses the site's primary one
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
      // -> The stored name is not always the one asked for: what happens to a file already in the
      //    folder is the site's upload conflict behavior to decide — it may be replaced, or the
      //    arrival may take the next free `name-1.ext` — so the content has to point at what the
      //    server says it stored
      const storedPath = assetPath(resp?.asset?.folderPath, resp?.asset?.fileName)
      pageStore.content = pageStore.content.replaceAll(item.blobUrl, storedPath)
      /*
        Applied to the editor's own model, and pruned from `pendingAssets`, immediately -- not
        batched until every item has landed. Before this fix, a later item's failure left the
        editor still showing the blob URLs for every item that HAD already succeeded (only
        `pageStore.content` was rewritten, and the next debounced flush from the live editor model
        would overwrite that rewrite right back out again), while `pendingAssets` still listed them
        as pending -- so retrying the save re-uploaded already-uploaded items as `name-1.ext`
        duplicates (OpenProject #945).
      */
      EVENT_BUS.emit('reloadEditorContent', {
        replacements: [{ from: item.blobUrl, to: storedPath }]
      })
      editorStore.pendingAssets = editorStore.pendingAssets.filter((pending) => pending !== item)
      URL.revokeObjectURL(item.blobUrl)
    }
    onDialogOK()
  } catch (err) {
    // -> An abort surfaces as a DOMException named AbortError from the underlying fetch, not a ky
    //    TimeoutError (there is no client-side timeout to fire one) -- a user cancel must read as
    //    exactly that, not as an unexplained server failure needing investigation.
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
