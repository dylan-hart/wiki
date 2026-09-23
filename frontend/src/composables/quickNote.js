import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

export const QUICK_NOTE_ROUTE = { path: '/_notes', query: { new: '1' } }

/**
 * Mod+Alt+N. With Cmd it matches `code`, since Option+N is a dead key on macOS and `key` reads
 * `Dead`/`˜`. With Ctrl it matches the typed `key`, because Windows reports AltGr as Ctrl+Alt: a
 * layout where AltGr+N types a character (Polish `ń`) is typing, not the shortcut.
 */
export function isQuickNoteChord(ev) {
  if (!ev || !ev.altKey || ev.shiftKey) {
    return false
  }
  if (ev.metaKey) {
    return !ev.ctrlKey && ev.code === 'KeyN'
  }
  return Boolean(ev.ctrlKey) && String(ev.key ?? '').toLowerCase() === 'n'
}

export function useQuickNote() {
  const router = useRouter()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const available = computed(
    () => Boolean(userStore.authenticated) && siteStore.features?.notes !== false
  )

  function open() {
    if (!available.value) {
      return false
    }
    router.push(QUICK_NOTE_ROUTE)
    return true
  }

  return { available, open }
}

export function useQuickNoteShortcut() {
  const siteStore = useSiteStore()
  const { available, open } = useQuickNote()

  function onKeydown(ev) {
    if (ev.defaultPrevented || ev.repeat || ev.isComposing || !isQuickNoteChord(ev)) {
      return
    }
    if (!available.value || siteStore.overlayIsShown) {
      return
    }
    ev.preventDefault()
    open()
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
  })

  return { onKeydown }
}
