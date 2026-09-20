import { defineAsyncComponent, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import { dialog } from '@/composables/dialog'
import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { log } from '@/helpers/log'
import { shouldPrefixLocale } from '@/helpers/pagePaths'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/**
 * Call synchronously during setup: the save-conflict watch registered below binds to the calling
 * component's effect scope.
 *
 * @param {object} opts
 * @param {{value: boolean}} opts.isSuggesting
 * @param {() => Promise<boolean>} opts.processPendingAssets Answers false when the save must not go
 *   ahead.
 */
export function usePageSaveFlow({ isSuggesting, processPendingAssets }) {
  const editorStore = useEditorStore()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()

  const router = useRouter()
  const route = useRoute()

  const { t } = useI18n()

  async function discardChanges() {
    /*
      A page being written has nothing stored to go back to, so the editor closes and the reader is
      put back on the site. `isActive` is part of the test, not just the mode: this button also
      appears with no editor open at all -- the properties panel writes straight to the page store --
      and that is an edit to a page that exists.
    */
    if (editorStore.isActive && editorStore.mode === 'create') {
      /*
        Timestamps equalized too, not just `isActive`: App.vue's navigation guards gate on
        `hasPendingChanges` alone, so leaving them unequal makes the `router.replace` below re-prompt
        for the discard the reader just confirmed.
      */
      const discardedAt = Temporal.Now.instant()
      editorStore.$patch({
        isActive: false,
        editor: '',
        lastSaveTimestamp: discardedAt,
        lastChangeTimestamp: discardedAt,
        /*
          The outermost create session ends here, so nothing downstream should still read this. Left
          set, a later unrelated edit-mode discard's `cancelPageEdit()` would load THIS stale origin
          page instead of the page actually being edited.
        */
        originPageId: ''
      })
      editorStore.clearPendingAssets()

      if (
        (pageStore.path === '' || pageStore.path === 'home') &&
        pageStore.locale === siteStore.locales.primary
      ) {
        siteStore.overlay = 'Welcome'
      }

      router.replace(
        shouldPrefixLocale(pageStore.locale, siteStore.localeRouting) ? `/${pageStore.locale}` : '/'
      )
      return
    }

    const hadPendingChanges = editorStore.hasPendingChanges
    const wasSuggesting = isSuggesting.value

    loading.show()
    try {
      /*
        The collab room behind an open editor autosaves a recoverable draft whenever its last
        participant leaves (`core/collab.ts#closeRoomIfEmpty`), with no way for the backend to tell
        "clicked Cancel" apart from a crash or a navigation-away. Best-effort: a failed delete only
        means the same draft is offered again next time, not a reason to block the discard.
      */
      try {
        await API_CLIENT.delete(`sites/${siteStore.id}/pages/${pageStore.id}/draft`)
      } catch (err) {
        log.warn('page', 'could not discard the recovery draft', err)
      }

      /*
        Order is load-bearing: closing the editor first draws the page view for a moment at the
        editor's route, and a redirection acts on that -- taking the author to its target instead of
        back to the page they discarded.
      */
      await pageStore.cancelPageEdit()
      editorStore.$patch({
        isActive: false,
        editor: '',
        // -> Reset, or the next editor opened inherits this one's mode
        mode: 'edit'
      })
      editorStore.clearPendingAssets()
      if (hadPendingChanges) {
        notify({
          type: 'positive',
          // -> Nothing was reverted in the suggest case: the page never changed, the draft did
          message: wasSuggesting
            ? t('common.page.suggestDiscarded')
            : t('common.page.revertSuccess')
        })
      }
    } catch (err) {
      // -> The editor closes either way: a page that would not reload is no reason to keep the
      //    reader in it
      editorStore.$patch({
        isActive: false,
        editor: '',
        mode: 'edit',
        originPageId: ''
      })
      editorStore.clearPendingAssets()
      notify({
        type: 'negative',
        message: t('common.page.reloadFailed')
      })
    }
    loading.hide()
  }

  async function saveChanges(closeAfter = false) {
    if (siteStore.features.reasonForChange !== 'off') {
      dialog({
        component: defineAsyncComponent(() => import('@/components/PageReasonForChangeDialog.vue')),
        componentProps: {
          required: siteStore.features.reasonForChange === 'required'
        }
      }).onOk(async ({ reason }) => {
        editorStore.$patch({
          reasonForChange: reason
        })
        saveChangesCommit(closeAfter)
      })
    } else {
      saveChangesCommit(closeAfter)
    }
  }

  async function saveChangesCommit(closeAfter = false) {
    if (!(await processPendingAssets())) {
      return
    }
    loading.show()
    try {
      const result = await pageStore.pageSave()
      notify({
        type: 'positive',
        message: t('common.page.saveSuccess')
      })
      /*
        Raising this page's classification does not cascade to its descendants -- some may now sit
        below the new floor -- so the dialog lists them for an admin to bump explicitly. After the
        success toast rather than instead of it: the save itself succeeded.
      */
      if (result?.classificationConflicts?.length > 0) {
        dialog({
          component: defineAsyncComponent(
            () => import('@/components/ClassificationResolutionDialog.vue')
          ),
          componentProps: {
            conflicts: result.classificationConflicts,
            floorClassification: pageStore.classification
          }
        })
      }
      if (closeAfter) {
        /*
          A redirection would take the author straight to its target the moment the editor closes, so
          `editorExitPath` parks them on a query change to the route already showing -- nothing is
          loaded again, and every other page is left alone down to its fragment. Awaited before the
          editor closes, or the page view drawn at the editor's route follows the redirection out
          from under this.
        */
        if (pageStore.editor === 'redirect' && route.fullPath !== pageStore.editorExitPath) {
          await router.replace(pageStore.editorExitPath)
        }
        editorStore.$patch({
          isActive: false,
          editor: ''
        })
        editorStore.clearPendingAssets()
      }
    } catch (err) {
      // -> A 409 has already put the resolution dialog up via the `saveConflict` watch; a generic
      //    failure toast on top of it would be noise for something that is not a dead end.
      if (err.message !== 'ERR_SAVE_CONFLICT') {
        notify({
          type: 'negative',
          message: t('common.page.saveFailed'),
          caption: err.message
        })
      }
    }
    loading.hide()
  }

  /**
   * Lives here rather than in any one `Editor*.vue` because every editor's Save routes through
   * `saveChangesCommit()` above, so one registration serves all of them.
   *
   * "Overwrite" re-bases on the server's `updatedAt` so the retried save passes the
   * `expectedUpdatedAt` check -- an informed overwrite, not the blind one that check guards against.
   *
   * Store-only by design: this file holds no reference to the mounted editor component, so a
   * "discard" corrects the content the next save would send while that editor's own on-screen copy
   * can lag until its next edit or a remount.
   */
  function resolveSaveConflict(snapshot) {
    dialog({
      component: defineAsyncComponent(() => import('@/components/PageSaveConflictDialog.vue')),
      componentProps: {
        authorName: snapshot.authorName,
        serverContent: snapshot.content,
        // -> Still this author's pending edit: `pageSave()`'s `contentFlusher` await put it on the
        //    store before the 409, and the store takes the server's content only on success.
        pendingContent: pageStore.content
      }
    })
      .onOk(async (action) => {
        if (action === 'discard') {
          editorStore.stashDiscardedContent(pageStore.content)
          pageStore.$patch({
            title: snapshot.title,
            content: snapshot.content,
            contentLoaded: true,
            updatedAt: snapshot.updatedAt
          })
          editorStore.markClean()
          notify({
            type: 'warning',
            message: t('editor.collab.saveConflict.discarded'),
            // -> The only remaining route back to the discarded text, so it outlasts the 5s default
            timeout: 10000,
            action: {
              label: t('editor.collab.saveConflict.undoDiscard'),
              onClick: undoDiscard
            }
          })
        } else if (action === 'overwrite') {
          pageStore.updatedAt = snapshot.updatedAt
          try {
            await pageStore.pageSave()
            notify({
              type: 'positive',
              message: t('editor.collab.saveConflict.saveSuccess')
            })
          } catch (err) {
            notify({
              type: 'negative',
              message: t('editor.collab.saveConflict.saveFailed'),
              caption: err.message
            })
          }
        }
      })
      .onDismiss(() => {
        editorStore.saveConflict = null
      })
  }

  function undoDiscard() {
    const content = editorStore.discardedContent
    if (content === null) {
      return
    }
    pageStore.$patch({ content, contentLoaded: true })
    editorStore.clearDiscardedContent()
  }

  watch(
    () => editorStore.saveConflict,
    (snapshot) => {
      if (snapshot) {
        resolveSaveConflict(snapshot)
      }
    }
  )

  return { discardChanges, saveChanges }
}
