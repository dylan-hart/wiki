import { onBeforeUnmount, onMounted } from 'vue'

import { useEditorStore } from '@/stores/editor'

export const SAVE_SHORTCUT_EVENT = 'saveShortcut'

export function requestSave() {
  EVENT_BUS.emit(SAVE_SHORTCUT_EVENT)
}

function isSaveChord(ev) {
  return (
    (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && String(ev.key).toLowerCase() === 's'
  )
}

export function useSaveShortcut(onSave) {
  const editorStore = useEditorStore()

  function onKeydown(ev) {
    if (ev.defaultPrevented || !isSaveChord(ev) || !editorStore.isActive) {
      return
    }
    ev.preventDefault()
    onSave()
  }

  onMounted(() => {
    EVENT_BUS.on(SAVE_SHORTCUT_EVENT, onSave)
    window.addEventListener('keydown', onKeydown)
  })

  onBeforeUnmount(() => {
    EVENT_BUS.off(SAVE_SHORTCUT_EVENT, onSave)
    window.removeEventListener('keydown', onKeydown)
  })
}
