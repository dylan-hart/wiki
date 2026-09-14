import { nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { useSiteStore } from '@/stores/site'

/**
 * Sort a drop's payload into uploadable files and rejected folders.
 *
 * `DataTransferItem.webkitGetAsEntry()` is what tells a dropped folder apart from a dropped file --
 * `dataTransfer.files` flattens both into one `FileList` with no such distinction, and a folder
 * dropped there shows up as a zero-byte, empty-`type` `File` that `uploadFiles` would happily POST
 * and the server would just as happily refuse as unreadable. Folders are rejected outright here
 * rather than walked recursively: nothing in this flow can recreate a folder's structure server-side
 * (`uploadFiles` uploads flat, into whichever folder is currently open), so recursing would either
 * silently flatten every nested file into that one folder or require a second, unrelated feature
 * (server-side folder creation from a client-supplied tree) to do properly. Despite the `webkit`
 * name this is a long-standing cross-browser API, not a Chromium-only one -- Firefox and Safari both
 * implement it -- but it is still checked for before use, and its absence falls back to the flattened
 * list rather than uploading nothing.
 */
export function collectDroppedFiles(dataTransfer) {
  const items = dataTransfer.items
  if (!items || items.length === 0 || typeof items[0]?.webkitGetAsEntry !== 'function') {
    return { files: [...dataTransfer.files], folderCount: 0 }
  }
  const files = []
  let folderCount = 0
  for (const item of items) {
    if (item.kind !== 'file') {
      continue
    }
    if (item.webkitGetAsEntry()?.isDirectory) {
      folderCount++
      continue
    }
    const file = item.getAsFile()
    if (file) {
      files.push(file)
    }
  }
  return { files, folderCount }
}

/**
 * The file manager's two upload on-ramps -- the hidden `multiple` file input and the drop zone --
 * and the single POST loop they both feed.
 *
 * The progress fields live on the component's own `state` (`isUploading`, `uploadPercentage`,
 * `shouldCancelUpload`, `isDraggingOver`, `loading`), since that is what the toolbar and the drop
 * overlay render from; only `dragDepth` is owned here, because nothing renders it.
 *
 * @param {object} opts
 * @param {object} opts.state The file manager's reactive state bag.
 * @param {{value: HTMLInputElement|null}} opts.fileIpt The hidden file input.
 * @param {() => void} opts.reloadCurrentFolder Re-reads the folder the upload landed in.
 */
export function useFileUpload({ state, fileIpt, reloadCurrentFolder }) {
  const siteStore = useSiteStore()
  const { t } = useI18n()

  /**
   * How many un-matched `dragenter`s the drop zone is currently inside.
   *
   * Not one of the reactive `state` fields: nothing in the template reads it, only `state.isDraggingOver`
   * does, and it exists purely to make that boolean correct. The drop zone's children (the scroll area,
   * the list rows) each fire their own `dragenter`/`dragleave` as the pointer crosses their edges, which
   * bubble up to the same handlers -- so entering a child fires `dragenter` again before the `dragleave`
   * that left the parent, and naively flipping a boolean on either event flickers the overlay off between
   * rows. Counting nets that out: the pair from moving between two children cancel, and only the very
   * first `dragenter` (count 0 -> 1) and the very last `dragleave` (count 1 -> 0) change `isDraggingOver`.
   */
  let dragDepth = 0

  function uploadFile() {
    fileIpt.value.click()
  }

  function uploadNewFiles() {
    if (!fileIpt.value.files?.length) {
      return
    }
    uploadFiles([...fileIpt.value.files])
  }

  /**
   * Upload one selection of files, through `sites/:siteId/assets` (one file) or
   * `sites/:siteId/assets/batch` (more than one) -- OpenProject #3233.
   *
   * The one path both on-ramps feed: the file-picker's `multiple` input (`uploadNewFiles`, above) and
   * the drop zone (`handleDrop`, below) both just gather a plain array of `File`s and hand it here,
   * rather than each driving its own upload loop and its own progress UI.
   *
   * A single file keeps hitting the single-file route unchanged: per Feature #3211's own triage,
   * that route stays real single-upload traffic going forward (and OpenProject #3234 gives it its
   * own tighter rate limit on that assumption) rather than becoming dead code. A multi-file
   * selection fires ONE multipart POST instead of the old sequential per-file loop -- `files` is
   * repeated once per file, the same convention `ImportBatchPageDialog.vue`'s own batch upload
   * already uses. Either way there is no longer a "between files" boundary a cancel can land on
   * once the request is sent (the old loop's per-file `await` gave the single-file case none of
   * that either), so a cancel here only takes effect before the request goes out.
   */
  async function uploadFiles(filesToUpload) {
    if (!filesToUpload?.length) {
      return
    }

    state.isUploading = true
    state.shouldCancelUpload = false
    state.uploadPercentage = 0

    state.loading++

    nextTick(() => {
      setTimeout(async () => {
        try {
          if (filesToUpload.length === 1) {
            const [fileToUpload] = filesToUpload
            if (!state.shouldCancelUpload) {
              state.uploadPercentage = 90
              // -> The body is the file itself rather than a multipart form. The locale is the one
              //    currently being browsed, so an upload lands in the same locale as the folder it
              //    was dropped into rather than always the site's primary.
              await API_CLIENT.post(`sites/${siteStore.id}/assets`, {
                searchParams: {
                  fileName: fileToUpload.name,
                  locale: state.locale,
                  ...(state.currentFolderId ? { folderId: state.currentFolderId } : {})
                },
                headers: {
                  'content-type': fileToUpload.type || 'application/octet-stream'
                },
                body: fileToUpload
              }).json()
            }
            state.uploadPercentage = 100
            reloadCurrentFolder()
            if (!state.shouldCancelUpload) {
              notify({
                type: 'positive',
                message: t('fileman.uploadSuccess')
              })
            }
          } else {
            let results = []
            if (!state.shouldCancelUpload) {
              state.uploadPercentage = 50
              const form = new FormData()
              for (const fileToUpload of filesToUpload) {
                form.append('files', fileToUpload, fileToUpload.name)
              }
              const resp = await API_CLIENT.post(`sites/${siteStore.id}/assets/batch`, {
                searchParams: {
                  locale: state.locale,
                  ...(state.currentFolderId ? { folderId: state.currentFolderId } : {})
                },
                body: form
              }).json()
              results = resp?.results ?? []
            }
            state.uploadPercentage = 100
            reloadCurrentFolder()
            if (!state.shouldCancelUpload) {
              const failed = results.filter((result) => !result.ok)
              if (failed.length > 0) {
                notify({
                  type: 'negative',
                  message: t('fileman.uploadFailed'),
                  caption: failed
                    .map((result) => `${result.fileName}: ${result.message}`)
                    .join('; ')
                })
              } else {
                notify({
                  type: 'positive',
                  message: t('fileman.uploadSuccess')
                })
              }
            }
          }
        } catch (err) {
          notify({
            type: 'negative',
            message: t('fileman.uploadFailed'),
            caption: apiErrorMessage(err, t('common.error.unexpected'))
          })
        }
        state.loading--
        // -> Only meaningful after the picker input drove this batch; a value on the drop path
        //    would have nothing to clear
        if (fileIpt.value) {
          fileIpt.value.value = null
        }
        setTimeout(() => {
          state.isUploading = false
          state.uploadPercentage = 0
        }, 1500)
      }, 400)
    })
  }

  function uploadCancel() {
    state.shouldCancelUpload = true
  }

  // --------------------------------------
  // DRAG-AND-DROP UPLOAD
  // --------------------------------------

  function handleDragEnter(ev) {
    // -> Not every drag is a file: text dragged out of the page itself, e.g. from the search field,
    //    fires the same events and should not open an upload overlay
    if (!ev.dataTransfer?.types?.includes('Files')) {
      return
    }
    dragDepth++
    state.isDraggingOver = true
  }

  function handleDragOver(ev) {
    // -> Otherwise the browser's default is to refuse the drop, which never fires `handleDrop`
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = 'copy'
    }
  }

  function handleDragLeave() {
    if (dragDepth <= 0) {
      return
    }
    dragDepth--
    if (dragDepth === 0) {
      state.isDraggingOver = false
    }
  }

  function handleDrop(ev) {
    dragDepth = 0
    state.isDraggingOver = false
    if (!ev.dataTransfer) {
      return
    }
    const { files: droppedFiles, folderCount } = collectDroppedFiles(ev.dataTransfer)
    if (folderCount > 0) {
      notify({
        type: 'negative',
        message: t('fileman.dropFoldersRejected'),
        caption: t('fileman.dropFoldersRejectedCount', { count: folderCount }, folderCount)
      })
    }
    if (droppedFiles.length > 0) {
      uploadFiles(droppedFiles)
    }
  }

  return {
    uploadFile,
    uploadNewFiles,
    uploadFiles,
    uploadCancel,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop
  }
}
