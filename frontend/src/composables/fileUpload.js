import { nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { useSiteStore } from '@/stores/site'

/**
 * `DataTransferItem.webkitGetAsEntry()` is the only thing that tells a dropped folder apart from a
 * dropped file: `dataTransfer.files` flattens both, and a folder shows up there as a zero-byte,
 * empty-`type` `File` that the server refuses as unreadable. Despite the `webkit` name it is
 * cross-browser, but its absence falls back to the flattened list rather than uploading nothing.
 *
 * Folders are rejected rather than walked: `uploadFiles` uploads flat into the open folder, so
 * recursing would silently collapse a tree until server-side folder creation exists.
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
 * The progress fields stay on the component's own `state`, since the toolbar and the drop overlay
 * render from them.
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
   * How many un-matched `dragenter`s the drop zone is currently inside. The zone's children each
   * fire their own `dragenter`/`dragleave` as the pointer crosses their edges, and entering a child
   * fires `dragenter` before the `dragleave` that left the parent -- so flipping a boolean on either
   * event flickers the overlay off between rows. Counting nets those pairs out, leaving only the
   * first `dragenter` and the last `dragleave` to move `state.isDraggingOver`.
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
   * A multi-file selection is ONE multipart POST with `files` repeated per file, not a loop, so
   * there is no "between files" boundary: a cancel only takes effect before the request goes out.
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
              // -> The locale being browsed, so an upload lands in the same locale as the folder it
              //    was dropped into rather than the site's primary
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
        // -> Clearing the picker is what lets the same file be chosen again; the drop path has no
        //    input to clear
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
    // -> Copy cursor over the zone; the template's `@dragover.prevent` is what makes the drop
    //    legal at all
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
