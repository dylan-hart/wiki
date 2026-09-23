import { reactive } from 'vue'

export function createNoteAutosave({ save, delay = 800, onError = null }) {
  const state = reactive({ status: 'idle' })
  const pending = new Map()
  const timers = new Map()
  const inflight = new Map()
  const failed = new Set()
  let savedOnce = false

  function refreshStatus() {
    if (inflight.size > 0) {
      state.status = 'saving'
    } else if (failed.size > 0) {
      state.status = 'error'
    } else if (pending.size > 0) {
      state.status = 'pending'
    } else {
      state.status = savedOnce ? 'saved' : 'idle'
    }
  }

  function clearTimer(noteId) {
    clearTimeout(timers.get(noteId))
    timers.delete(noteId)
  }

  function run(noteId) {
    if (inflight.has(noteId)) {
      return inflight.get(noteId)
    }
    if (!pending.has(noteId)) {
      return Promise.resolve()
    }
    const job = (async () => {
      while (pending.has(noteId)) {
        const patch = pending.get(noteId)
        pending.delete(noteId)
        try {
          await save(noteId, patch)
          failed.delete(noteId)
          savedOnce = true
        } catch (err) {
          pending.set(noteId, { ...patch, ...pending.get(noteId) })
          failed.add(noteId)
          onError?.(err, noteId)
          break
        }
      }
    })().finally(() => {
      inflight.delete(noteId)
      refreshStatus()
    })
    inflight.set(noteId, job)
    refreshStatus()
    return job
  }

  function schedule(noteId, patch) {
    pending.set(noteId, { ...pending.get(noteId), ...patch })
    clearTimer(noteId)
    timers.set(
      noteId,
      setTimeout(() => {
        timers.delete(noteId)
        run(noteId)
      }, delay)
    )
    refreshStatus()
  }

  async function flush(noteId = null) {
    const ids = noteId ? [noteId] : [...new Set([...pending.keys(), ...inflight.keys()])]
    for (const id of ids) {
      clearTimer(id)
    }
    await Promise.all(
      ids.map(async (id) => {
        await inflight.get(id)
        await run(id)
      })
    )
  }

  function cancel(noteId) {
    clearTimer(noteId)
    pending.delete(noteId)
    failed.delete(noteId)
    refreshStatus()
  }

  function hasPending() {
    return pending.size > 0 || inflight.size > 0
  }

  function dispose() {
    for (const id of timers.keys()) {
      clearTimer(id)
    }
  }

  return { state, schedule, flush, cancel, hasPending, dispose }
}
