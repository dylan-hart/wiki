import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'

import { confirm, dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { isHomePath } from '@/helpers/pagePaths'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import AssetRenameDialog from '@/components/AssetRenameDialog.vue'
import FolderCreateDialog from '@/components/FolderCreateDialog.vue'
import FolderRenameDialog from '@/components/FolderRenameDialog.vue'

/**
 * Everything the file manager DOES to a folder, a page or an asset -- the create/rename/duplicate/
 * move/delete actions its context menus, its toolbar and its item rows all reach.
 *
 * Each is the same shape: open a dialog (or a confirm), then either call a store action or DELETE
 * through the API, then reload the folder the change landed in. The listing itself -- `loadTree`,
 * the tree component, the state bag -- stays with the component, and is passed in.
 *
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

  // --------------------------------------
  // FOLDER METHODS
  // --------------------------------------

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
      // // -> Delete current folder and children from cache
      // const fPath = [state.treeNodes[folderId].folderPath, state.treeNodes[folderId].fileName].filter(p => !!p).join('/')
      // delete state.treeNodes[folderId]
      // for (const [nodeId, node] of Object.entries(state.treeNodes)) {
      //   if (node.folderPath.startsWith(fPath)) {
      //     delete state.treeNodes[nodeId]
      //   }
      // }
      // -> Reload tree
      await loadTree({ parentId: folderId, types: ['folder'], initLoad: true }) // Update tree
      // -> Reload current view (in case current folder is included)
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

  // --------------------------------------
  // PAGE METHODS
  // --------------------------------------

  function rerenderPage(item) {
    dialog({
      component: defineAsyncComponent(() => import('@/components/RerenderPageDialog.vue')),
      componentProps: {
        id: item.id
      }
    })
  }

  /**
   * Copy a page, through the same dialog the page view's action rail opens.
   *
   * The copy is not written here: what comes back is where it should go, and the store opens the editor
   * on an unsaved page holding the source's content -- so the author lands in the same place they would
   * have from the page itself, and nothing exists until they save it.
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
        // -> The locale this item was listed under, not `pageStore.locale` -- the file being
        //    duplicated is whatever locale `state.locale` is currently browsing, which may not be
        //    the locale of the page (if any) open in the editor underneath this overlay
        locale: state.locale
      }
    }).onOk(async (opts) => {
      try {
        await pageStore.pageDuplicate({
          sourcePageId: item.id,
          path: opts.path,
          title: opts.title
        })
        // -> The editor is now underneath this overlay, as it is after opening a page to edit
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
   * Rename a page, move it, or both.
   *
   * One action rather than two, through the same dialog the page view's action rail opens: what it
   * hands back is a title and the full path the page should sit at, and only the path decides which of
   * the two endpoints that is -- a page whose title changed in place was never moved.
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
        // -> See the same note in `duplicatePage`, just above
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
      // -> Reload current view
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
        // -> Reload current view
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

  // --------------------------------------
  // ASSET METHODS
  // --------------------------------------

  function renameAsset(assetId) {
    dialog({
      component: AssetRenameDialog,
      componentProps: {
        assetId
      }
    }).onOk(async () => {
      // -> Reload current view
      await loadTree({ parentId: state.currentFolderId })
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
      // -> Reload current view
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
    delAsset
  }
}
