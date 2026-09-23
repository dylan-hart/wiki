import { reactive } from 'vue'

/**
 * `delay` is the pause in typing that triggers a save. `minInterval` is the least time between two
 * saves of the same note, however the pauses fall: every save is a request against the per-user
 * `/_api` rate limit, and a steady typist pausing just past `delay` would otherwise spend it fast
 * enough to be banned. The last edit is always saved, only later; `flush()` does not wait.
 */
export function createNoteAutosave({ save, delay = 800, minInterval = 3000, onError = null }) {
  const state = reactive({ status: 'idle' })
  const pending = new Map()
  const timers = new Map()
  const inflight = new Map()
  const lastSentAt = new Map()
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

  function arm(noteId) {
    clearTimer(noteId)
    const sinceLast = Date.now() - (lastSentAt.get(noteId) ?? -Infinity)
    timers.set(
      noteId,
      setTimeout(
        () => {
          timers.delete(noteId)
          run(noteId)
        },
        Math.max(delay, minInterval - sinceLast)
      )
    )
  }

  /** Sends one save of whatever is pending; resolves `true` once it is stored, `false` if not. */
  function run(noteId) {
    if (inflight.has(noteId)) {
      return inflight.get(noteId)
    }
    if (!pending.has(noteId)) {
      return Promise.resolve(true)
    }
    clearTimer(noteId)
    const patch = pending.get(noteId)
    pending.delete(noteId)
    lastSentAt.set(noteId, Date.now())
    const job = (async () => {
      try {
        await save(noteId, patch)
        failed.delete(noteId)
        savedOnce = true
        return true
      } catch (err) {
        pending.set(noteId, { ...patch, ...pending.get(noteId) })
        failed.add(noteId)
        onError?.(err, noteId)
        return false
      }
    })().finally(() => {
      inflight.delete(noteId)
      // -> Edits made while this save was in flight go out on their own timer, still spaced.
      if (pending.has(noteId) && !failed.has(noteId) && !timers.has(noteId)) {
        arm(noteId)
      }
      refreshStatus()
    })
    inflight.set(noteId, job)
    refreshStatus()
    return job
  }

  function schedule(noteId, patch) {
    pending.set(noteId, { ...pending.get(noteId), ...patch })
    arm(noteId)
    refreshStatus()
  }

  async function drain(noteId) {
    for (;;) {
      clearTimer(noteId)
      await inflight.get(noteId)
      clearTimer(noteId)
      if (!pending.has(noteId) || !(await run(noteId))) {
        return
      }
    }
  }

  async function flush(noteId = null) {
    const ids = noteId ? [noteId] : [...new Set([...pending.keys(), ...inflight.keys()])]
    await Promise.all(ids.map(drain))
  }

  function cancel(noteId) {
    clearTimer(noteId)
    pending.delete(noteId)
    failed.delete(noteId)
    refreshStatus()
  }

  function hasPending(noteId = null) {
    if (noteId) {
      return pending.has(noteId) || inflight.has(noteId)
    }
    return pending.size > 0 || inflight.size > 0
  }

  function dispose() {
    for (const id of timers.keys()) {
      clearTimer(id)
    }
  }

  return { state, schedule, flush, cancel, hasPending, dispose }
}
