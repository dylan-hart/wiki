import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'

import { confirm, dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { isHomePath } from '@/helpers/pagePaths'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import AssetPreviewDialog from '@/components/AssetPreviewDialog.vue'
import AssetRenameDialog from '@/components/AssetRenameDialog.vue'
import FolderCreateDialog from '@/components/FolderCreateDialog.vue'
import FolderRenameDialog from '@/components/FolderRenameDialog.vue'

/**
 * @param {object} opts
 * @param {object} opts.state The file manager's reactive state bag.
 * @param {{value: object|null}} opts.treeComp The `TreeNav` component instance.
 * @param {(args: object) => Promise<void>} opts.loadTree The component's own tree loader.
 * @param {() => void} opts.close Dismiss the file manager overlay.
 */
export function useFileManagerActions({ state, treeComp, loadTree, close }) {
  const pageStore = usePageStore()
  const siteStore = useSiteStore()

  const { t } = useI18n()

  function newFolder(parentId) {
    dialog({
      component: FolderCreateDialog,
      componentProps: {
        parentId
      }
    }).onOk(() => {
      loadTree({ parentId })
    })
  }

  function renameFolder(folderId) {
    dialog({
      component: FolderRenameDialog,
      componentProps: {
        folderId
      }
    }).onOk(async () => {
      treeComp.value.resetLoaded()
      await loadTree({ parentId: folderId, types: ['folder'], initLoad: true })
      await loadTree({ parentId: state.currentFolderId })
    })
  }

  function delFolder(folderId, mustReload = false) {
    confirm({
      title: t('folderDeleteDialog.title'),
      message: t('folderDeleteDialog.confirm', {
        name: `**${state.treeNodes[folderId].title}**`
      }),
      caption: t('folderDeleteDialog.folderId', { id: folderId }),
      destructive: true,
      persistent: true
    }).onOk(async () => {
      try {
        await API_CLIENT.delete(`sites/${siteStore.id}/tree/folders/${folderId}`)
        notify({
          type: 'positive',
          message: t('folderDeleteDialog.deleteSuccess')
        })
      } catch (err) {
        // -> ky throws above 400 -- a folder deleted from another tab answers 404
        notify({
          type: 'negative',
          message: apiErrorMessage(err)
        })
        return
      }
      for (const nodeId in state.treeNodes) {
        if (state.treeNodes[nodeId].children.includes(folderId)) {
          state.treeNodes[nodeId].children = state.treeNodes[nodeId].children.filter(
            (c) => c !== folderId
          )
        }
      }
      delete state.treeNodes[folderId]
      if (state.treeRoots.includes(folderId)) {
        state.treeRoots = state.treeRoots.filter((n) => n !== folderId)
      }
      if (mustReload) {
        loadTree({ parentId: state.currentFolderId })
      }
    })
  }

  function reloadFolder(folderId) {
    loadTree({ parentId: folderId })
    treeComp.value.resetLoaded()
  }

  function rerenderPage(item) {
    dialog({
      component: defineAsyncComponent(() => import('@/components/RerenderPageDialog.vue')),
      componentProps: {
        id: item.id
      }
    })
  }

  /**
   * No copy is written here: the store opens the editor on an unsaved page holding the source's
   * content, so nothing exists until the author saves it.
   */
  function duplicatePage(item) {
    dialog({
      component: defineAsyncComponent(() => import('@/components/TreeBrowserDialog.vue')),
      componentProps: {
        mode: 'duplicatePage',
        itemId: item.id,
        itemTitle: item.title,
        folderPath: item.folderPath,
        itemFileName: item.fileName,
        // -> The locale this item was listed under, not `pageStore.locale` -- the page open in the
        //    editor underneath this overlay may be in another one
        locale: state.locale
      }
    }).onOk(async (opts) => {
      try {
        await pageStore.pageDuplicate({
          sourcePageId: item.id,
          path: opts.path,
          title: opts.title
        })
        // -> Reveals the editor the store has just opened underneath this overlay
        close()
      } catch (err) {
        notify({
          type: 'negative',
          message: t('fileman.duplicateFailed'),
          caption: apiErrorMessage(err, t('common.error.unexpected'))
        })
      }
    })
  }

  /**
   * Rename and move are one action: the dialog hands back a title and a full path, and only the
   * path decides which of the two endpoints is called.
   */
  function renameMovePage(item) {
    const currentPath = item.folderPath ? `${item.folderPath}/${item.fileName}` : item.fileName
    dialog({
      component: defineAsyncComponent(() => import('@/components/TreeBrowserDialog.vue')),
      componentProps: {
        mode: 'renamePage',
        itemId: item.id,
        itemTitle: item.title,
        folderPath: item.folderPath,
        itemFileName: item.fileName,
        // -> The locale this item was listed under, as in `duplicatePage`
        locale: state.locale
      }
    }).onOk((opts) => {
      const isMove = opts.path !== currentPath
      // -> A title-only rename never moves the page off `home`, so only an actual move needs the guard
      if (isMove && isHomePath(currentPath)) {
        confirm({
          title: t('pages.homepageGuard.moveTitle'),
          message: t('pages.homepageGuard.moveMessage', { name: item.title }),
          cancel: true,
          color: 'negative',
          okLabel: t('pages.homepageGuard.proceed')
        }).onOk(() => applyRenameOrMovePage(item, opts, isMove))
      } else {
        applyRenameOrMovePage(item, opts, isMove)
      }
    })
  }

  async function applyRenameOrMovePage(item, opts, isMove) {
    try {
      if (!isMove) {
        await pageStore.pageRename({ id: item.id, title: opts.title })
        notify({
          type: 'positive',
          message: t('pages.renameSuccess')
        })
      } else {
        await pageStore.pageMove({
          id: item.id,
          path: opts.path,
          title: opts.title,
          includeTranslations: opts.includeTranslations
        })
        notify({
          type: 'positive',
          message: t('pages.moveSuccess')
        })
      }
      await loadTree({ parentId: state.currentFolderId })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('fileman.renameMoveFailed'),
        caption: apiErrorMessage(err, t('common.error.unexpected'))
      })
    }
  }

  function delPage(pageId, pageName, pagePath) {
    const openDeleteDialog = () => {
      dialog({
        component: defineAsyncComponent(() => import('@/components/PageDeleteDialog.vue')),
        componentProps: {
          pageId,
          pageName
        }
      }).onOk(() => {
        loadTree({ parentId: state.currentFolderId })
      })
    }
    if (isHomePath(pagePath)) {
      confirm({
        title: t('pages.homepageGuard.deleteTitle'),
        message: t('pages.homepageGuard.deleteMessage', { name: pageName }),
        cancel: true,
        color: 'negative',
        okLabel: t('pages.homepageGuard.proceed')
      }).onOk(openDeleteDialog)
    } else {
      openDeleteDialog()
    }
  }

  function renameAsset(assetId) {
    dialog({
      component: AssetRenameDialog,
      componentProps: {
        assetId
      }
    }).onOk(async () => {
      await loadTree({ parentId: state.currentFolderId })
    })
  }

  function moveAsset(item) {
    dialog({
      component: defineAsyncComponent(() => import('@/components/TreeBrowserDialog.vue')),
      componentProps: {
        mode: 'moveItem',
        folderPath: item.folderPath,
        locale: state.locale
      }
    }).onOk(async (destination) => {
      try {
        await API_CLIENT.put(`sites/${siteStore.id}/assets/${item.id}/folder`, {
          json: { folderId: destination.folderId, parentPath: destination.parentPath }
        }).json()
        notify({
          type: 'positive',
          message: t('fileman.moveAssetSuccess')
        })
      } catch (err) {
        notify({
          type: 'negative',
          message: t('fileman.moveAssetFailed'),
          caption: apiErrorMessage(err, t('common.error.unexpected'))
        })
        return
      }
      await loadTree({ parentId: state.currentFolderId })
    })
  }

  function previewAsset(item) {
    dialog({
      component: AssetPreviewDialog,
      componentProps: {
        assetId: item.id,
        fileName: item.fileName,
        folderPath: item.folderPath ?? '',
        fileSize: item.fileSize,
        mimeType: item.mimeType
      }
    })
  }

  function delAsset(assetId, assetName) {
    confirm({
      title: t('fileman.assetDelete'),
      message: t('fileman.assetDeleteConfirm', { name: `**${assetName}**` }),
      caption: t('fileman.assetDeleteId', { id: assetId }),
      destructive: true,
      persistent: true
    }).onOk(async () => {
      try {
        await API_CLIENT.delete(`sites/${siteStore.id}/assets/${assetId}`)
        notify({
          type: 'positive',
          message: t('fileman.assetDeleteSuccess')
        })
      } catch (err) {
        // -> ky throws above 400 -- an asset deleted from another tab answers 404
        notify({
          type: 'negative',
          message: apiErrorMessage(err)
        })
        return
      }
      await loadTree({ parentId: state.currentFolderId })
    })
  }

  return {
    newFolder,
    renameFolder,
    delFolder,
    reloadFolder,
    rerenderPage,
    duplicatePage,
    renameMovePage,
    delPage,
    renameAsset,
    moveAsset,
    previewAsset,
    delAsset
  }
}
