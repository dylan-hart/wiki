import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  bindCollabEditor,
  collabStatusEffects,
  startCollabSession,
  stopCollabSession
} from '@/composables/collab'
import { MonacoYjsBinding } from '@/composables/monacoYjsBinding'
import { notify } from '@/composables/notify'

import { useCollabStore } from '@/stores/collab'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * The Monaco-specific half of live collaborative editing; `composables/collab.js` owns the session
 * itself (socket, provider, awareness) for every editor.
 *
 * `stop()` is returned rather than hung on an `onBeforeUnmount` of its own: it has to run before
 * the component disposes the editor the watchers below still reach for, and the component's own
 * unmount hook is where that ordering is expressed.
 */
export function useMarkdownCollab() {
  const collabStore = useCollabStore()
  const editorStore = useEditorStore()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const { t } = useI18n()

  /**
   * Deliberately narrow: a page being created has no id to gather anyone around yet, and a
   * suggestion is a private draft of a page the author may not write to -- the server refuses a
   * room for either, so asking would only produce a rejected socket on every keystroke.
   */
  const collabEnabled = computed(
    () =>
      siteStore.features.collaborativeEditing &&
      userStore.authenticated &&
      editorStore.mode === 'edit' &&
      Boolean(pageStore.id)
  )

  /**
   * Vue only auto-binds a `watch()` to the component's effect scope when it is created
   * synchronously during setup, and `start()` runs after the mount hook's first `await`. These two
   * would therefore never be stopped on unmount -- firing against a disposed editor, and once per
   * past mount for every collaborator save -- so `stop()` ends them by hand.
   */
  let stopCollabStatusWatch = null
  let stopCollabLastSaveWatch = null

  /** @param {object} editor The live Monaco editor instance. */
  function start(editor) {
    if (!collabEnabled.value) {
      return
    }

    /*
      `pageStore.activeEditors` came with the page itself, read off whatever room the server already
      has for it, so "someone else has this open" can be said immediately rather than after the
      session below has connected.
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
      Read-only until the shared document has arrived: the binding starts by making the editor say
      what the document says, so anything typed before it exists is about to be overwritten -- by an
      empty document, if the sync has not landed. The session gives up after a few seconds (usually
      a proxy that does not forward websocket upgrades) and releases the editor as an ordinary one,
      so this cannot strand an author in a page they cannot type in.
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
            return new MonacoYjsBinding(ytext, model, new Set([editor]), awareness)
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
      The session has already put the editor state back to "nothing pending" when another author
      saves; this only tells the author why their Save button went quiet.
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

  /** Safe to call when `start()` never joined a room. */
  function stop() {
    // -> Before `stopCollabSession()`, which patches `collabStore.status` to `off` and would
    //    otherwise wake the status watcher against an editor on its way out
    stopCollabStatusWatch?.()
    stopCollabLastSaveWatch?.()
    stopCollabSession()
  }

  return { collabEnabled, start, stop }
}
