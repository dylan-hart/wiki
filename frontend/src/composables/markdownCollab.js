import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MonacoBinding } from 'y-monaco'

import {
  bindCollabEditor,
  collabStatusEffects,
  startCollabSession,
  stopCollabSession
} from '@/composables/collab'
import { notify } from '@/composables/notify'

import { useCollabStore } from '@/stores/collab'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * The markdown editor's half of live collaborative editing: whether it applies at all, joining the
 * room once Monaco exists, and leaving it again.
 *
 * Kept apart from `composables/collab.js`, which owns the session itself (socket, provider, awareness)
 * for every editor. This is only the Monaco-specific wiring `EditorMarkdown.vue` used to hold inline
 * -- the `MonacoBinding`, the read-only gate while the shared document is still arriving, and the two
 * notifications that tell an author what the session is doing.
 *
 * `stop()` is returned rather than hung on an `onBeforeUnmount` of its own: it has to run before the
 * component disposes the editor the watchers below still reach for, and the component's own unmount
 * hook is where that ordering is expressed.
 */
export function useMarkdownCollab() {
  const collabStore = useCollabStore()
  const editorStore = useEditorStore()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const { t } = useI18n()

  /**
   * Whether this edit is shared with whoever else has the page open.
   *
   * Deliberately narrow. A page being created has no id to gather anyone around yet, and a suggestion is
   * one person's private draft of a page they may not write to — the server refuses a room for it, and
   * asking for one anyway would only produce a rejected socket on every keystroke of every suggestion.
   */
  const collabEnabled = computed(
    () =>
      siteStore.features.collaborativeEditing &&
      userStore.authenticated &&
      editorStore.mode === 'edit' &&
      Boolean(pageStore.id)
  )

  /**
   * Stop handles for the two collab watchers started by `start()`, kept because both are created after
   * the mount hook's first `await` (the settings/blocks fetch), and Vue only auto-binds a `watch()` to
   * the component's effect scope when it is created synchronously during setup -- one created after an
   * `await` is never auto-stopped on unmount, and fires on for the life of the store. Left running past
   * unmount, the `status` watcher calls `editor.updateOptions()` against an editor the component has
   * already `dispose()`d (a console error on every exit from a collab-enabled edit), and the `lastSave`
   * watcher fires once per past mount for a save from another collaborator -- duplicate "saved by X"
   * notifications (OpenProject #942). Explicitly `stop()`ed by `stop()` below instead.
   */
  let stopCollabStatusWatch = null
  let stopCollabLastSaveWatch = null

  /**
   * Join the room for this page, if there is one to join, and keep the editor in step with it.
   *
   * @param {object} editor The live Monaco editor instance.
   */
  function start(editor) {
    if (!collabEnabled.value) {
      return
    }

    /*
      "Someone else already has this open" -- said once, before the collab session below has even
      asked to connect. `pageStore.activeEditors` came with the page itself (`viewer.activeEditors` on
      `GET .../pages/:id`, task 546), read off whatever room `core/collab.ts` already has for it on
      this instance -- so this can be shown immediately, without waiting on a socket.
    */
    if (pageStore.activeEditors.count > 0) {
      notify({
        type: 'info',
        message: t('editor.collab.activeEditors', pageStore.activeEditors.count, {
          count: pageStore.activeEditors.count
        })
      })
    }

    /*
      Read-only until the shared document has arrived, and only that first time.

      The binding below starts by making the editor say what the document says, so anything typed
      before it exists is about to be overwritten -- by an empty document, if the sync has not landed
      yet. The session gives up after a few seconds (a proxy that does not forward websocket upgrades
      is the usual reason) and the editor is released as an ordinary one, so this cannot strand an
      author in a page they are unable to type in.
    */
    editor.updateOptions({ readOnly: true })
    startCollabSession({ siteId: siteStore.id, pageId: pageStore.id })

    stopCollabStatusWatch = watch(
      () => collabStore.status,
      (status) => {
        const effects = collabStatusEffects(status, collabStore.hasSynced)
        if (effects.shouldBindEditor) {
          bindCollabEditor((ytext, awareness) => {
            const model = editor.getModel()
            if (!model) {
              return null
            }
            return new MonacoBinding(ytext, model, new Set([editor]), awareness)
          })
        }
        editor.updateOptions({ readOnly: effects.readOnly })
        if (effects.notifyDenied) {
          notify({
            type: 'warning',
            message: t('editor.collab.notAllowed')
          })
        }
      }
    )

    /*
      Somebody else saved the page. The editor state has already been put back to "nothing pending" by
      the session -- this is only so that the author is told why their Save button went quiet.
    */
    stopCollabLastSaveWatch = watch(
      () => collabStore.lastSave,
      (lastSave) => {
        if (lastSave && lastSave.authorId !== userStore.id) {
          notify({
            type: 'positive',
            message: t('editor.collab.savedBy', { name: lastSave.authorName })
          })
        }
      }
    )
  }

  /** Leave the room and stop the two watchers. Safe to call when `start()` never joined one. */
  function stop() {
    // -> Stopped before `stopCollabSession()` patches `collabStore.status` to `off` -- these were
    //    started after the mount hook's first `await` so Vue never auto-bound them to the component's
    //    effect scope, and left running they fire past unmount against a disposed editor (OpenProject
    //    #942).
    stopCollabStatusWatch?.()
    stopCollabLastSaveWatch?.()
    stopCollabSession()
  }

  return { collabEnabled, start, stop }
}
