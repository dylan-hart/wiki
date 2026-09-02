import { defineAsyncComponent, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import { dialog } from '@/composables/dialog'
import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { shouldPrefixLocale } from '@/helpers/pagePaths'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/**
 * The header's save/discard/conflict/undo cluster: everything behind its Save Changes and Discard
 * buttons, plus the resolution dialog a 409 puts up and the undo that follows a discard.
 *
 * Split out of `PageHeader.vue` because none of it is about the header -- the header is where the
 * buttons happen to live, and the flow itself is entirely store, dialog and router work. What it
 * does need from the header is the two answers only the header has: whether this edit is a
 * suggestion, and whether the page's pending assets could be committed first.
 *
 * The save-conflict watch is registered here, synchronously during setup, so it is bound to the
 * calling component's effect scope exactly as it was when it lived in the header.
 *
 * @param {object} opts
 * @param {{value: boolean}} opts.isSuggesting Whether the open editor is in `suggest` mode.
 * @param {() => Promise<boolean>} opts.processPendingAssets Commits any pending asset renames,
 *   answering false when the save must not go ahead.
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
      Abandoning a page that is being written, which is a different thing from reverting an edit: there
      is nothing stored to go back to, so the editor closes and the reader is put back on the site.

      `isActive` is part of the test, not just the mode. This button also appears with no editor open at
      all -- the properties panel writes straight to the page store, and this is how those changes are
      dropped -- and that is an edit to a page that exists, however the editor was last used.
    */
    if (editorStore.isActive && editorStore.mode === 'create') {
      /*
        Timestamps equalized here too, not just `isActive` (OpenProject #1129 follow-on): App.vue's
        navigation guards gate on `hasPendingChanges` alone, so leaving them unequal would have the
        `router.replace` below -- a real navigation -- immediately re-trigger a confirm prompt for the
        discard the reader just clicked through.
      */
      const discardedAt = Temporal.Now.instant()
      editorStore.$patch({
        isActive: false,
        editor: '',
        lastSaveTimestamp: discardedAt,
        lastChangeTimestamp: discardedAt
      })

      // Is it the home page in create mode?
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
        The page is put back, and only then does the editor close. The other order draws the page view
        for a moment at the route the editor was on, which a redirection reads as "nobody is holding
        me" and acts on -- taking the author to its target instead of back to the page they discarded.
      */
      await pageStore.cancelPageEdit()
      editorStore.$patch({
        isActive: false,
        editor: '',
        // -> Back to the ordinary meaning of the editor, or the next thing opened would inherit this one
        mode: 'edit'
      })
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
      // -> The editor closes either way: the reader asked to leave it, and a page that would not
      //    reload is not a reason to keep them in it
      editorStore.$patch({ isActive: false, editor: '', mode: 'edit' })
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
        OpenProject #1080: raising this page's own classification does not cascade to its
        descendants -- some may now sit below the new floor. Rather than leaving that silent, the
        resolution dialog lists them for an admin to bump explicitly. Shown after the success
        notification rather than instead of it: the save itself succeeded regardless of what this
        surfaces.
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
          The editor closes onto the page, and for a redirection that page would take the author
          straight to the target they just chose. `editorExitPath` holds it instead — a change of query
          on the route already showing, so nothing is loaded again. Every other page is left alone,
          down to the fragment it was opened at.

          Before the editor closes, and awaited: the page view drawn at the editor's route would read
          the query as it stands and follow the redirection out from under this.
        */
        if (pageStore.editor === 'redirect' && route.fullPath !== pageStore.editorExitPath) {
          await router.replace(pageStore.editorExitPath)
        }
        editorStore.$patch({
          isActive: false,
          editor: ''
        })
      }
    } catch (err) {
      // -> A 409 already means `resolveSaveConflict()` below is putting the resolution dialog up (via
      //    the `saveConflict` watch) -- a generic toast on top of it would be redundant noise for
      //    something that is not a dead end. Anything else genuinely failed and is reported as before.
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
   * Puts up the resolution dialog once `pageStore.pageSave()` has flagged a save the server refused
   * because somebody else saved first (`editorStore.saveConflict`, the page snapshot the 409 came back
   * with -- see `stores/page.js`). Lives here rather than in any one `Editor*.vue`: every editor's Save
   * button already routes through `saveChangesCommit()` above, so this is what makes the dialog
   * reachable from all of them instead of only whichever editor happened to watch for it (OpenProject
   * #1747 hoisted this out of `EditorMarkdown.vue`, which had it first only because Markdown was the
   * first editor built, not because a conflict is a Markdown-specific concern).
   *
   * Offers two ways out: adopt the server's version wholesale, or re-issue the save with the server's
   * `updatedAt` as the new baseline -- an informed overwrite, now that this author has been told there
   * was something to overwrite, rather than the blind one `expectedUpdatedAt` exists to prevent. Either
   * choice recovers this author's edit one way or another, so a 409 is never a dead end (OpenProject
   * #838, upstream requarks/wiki #2256). Nothing here is lost if the overwrite's own `pageSave()` hits a
   * second conflict either: the 409 handler in `stores/page.js` sets `editorStore.saveConflict` again,
   * which re-triggers the `watch` below and puts this same dialog back up with the newer snapshot.
   *
   * Only `pageStore`/`editorStore` state is touched here, deliberately: this file has no reference to
   * whichever editor component is actually mounted, so a "discard" cannot reach into its live view the
   * way `EditorMarkdown.vue`'s own version once could (calling `editor.setValue()` on its local Monaco
   * instance and re-rendering its preview pane). The page's stored content -- what the next save would
   * actually send -- is corrected either way; what can lag a beat behind it is that one editor's own
   * on-screen copy, until its next edit or a remount.
   *
   * A "Discard" choice is itself still recoverable (OpenProject #2073): the author's pending content is
   * stashed in `editorStore.discardedContent` right before it is overwritten, and the toast that
   * follows offers it straight back via `undoDiscard()` below. As with discard itself, the restore is
   * store-only -- a mounted editor picks the content back up on its own next render or remount, rather
   * than this file reaching into a Monaco instance it has no reference to.
   */
  function resolveSaveConflict(snapshot) {
    dialog({
      component: defineAsyncComponent(() => import('@/components/PageSaveConflictDialog.vue')),
      componentProps: {
        authorName: snapshot.authorName,
        serverContent: snapshot.content,
        // -> Already flushed onto the store by `pageSave()`'s `contentFlusher` await, before the 409
        //    that set `snapshot` was ever thrown -- so this is still this author's pending edit, not
        //    the server's content the store gets patched with only on a successful save.
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
          // -> Adopting the server's copy leaves nothing of this author's pending; see `hasPendingChanges`
          editorStore.markClean()
          notify({
            type: 'warning',
            message: t('editor.collab.saveConflict.discarded'),
            // -> Longer than the 5s default: this toast is the only remaining route back to the
            //    author's discarded text, so it should still be there a moment after a quick glance.
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

  /**
   * Restores the author's own content after a save-conflict "Discard" replaced it with the server's
   * snapshot -- the undo action offered on the toast `resolveSaveConflict` raises right after
   * (OpenProject #2073). Store-only, matching `resolveSaveConflict`'s own discard branch: puts the
   * stashed copy back into `pageStore.content` and clears the stash so a stray second click -- the
   * toast is already gone by then, but nothing stops calling this directly -- has nothing left to
   * restore. A mounted editor picks the restored content up the same way it would any other external
   * change to `pageStore.content`.
   */
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
