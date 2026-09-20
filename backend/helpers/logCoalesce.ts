/**
 * Fold a burst of identical-in-kind log events into one summary line.
 *
 * A credential-guessing run produces one refusal per attempt, and printing every one buries
 * everything else. Printing none is worse — the first few are how an operator learns the run is
 * happening at all.
 *
 * Every decision about what a line SAYS belongs to the caller. The per-key timer is `unref()`ed, so
 * a pending summary never keeps the process alive past a shutdown.
 */

/**
 * `total` counts EVERY event seen in the window, the ones that were emitted individually included —
 * it is the number an operator wants ("twenty attempts from this address"). The remainder is
 * `suppressed`.
 */
export interface CoalesceSummary {
  key: string
  total: number
  suppressed: number
  windowMs: number
}

export interface CoalesceOptions {
  /**
   * How many events in a window are emitted individually before the rest fold into the summary.
   * The default is enough for an operator tailing the log to see the shape of what is starting
   * (which address, which reason) before it collapses into a count.
   */
  threshold?: number
}

export const DEFAULT_COALESCE_THRESHOLD = 3

interface PendingWindow {
  total: number
  timer: ReturnType<typeof setTimeout>
  windowMs: number
  threshold: number
  emit: (summary: CoalesceSummary) => void
}

const pending = new Map<string, PendingWindow>()

function flush(key: string): void {
  const entry = pending.get(key)
  if (!entry) {
    return
  }
  // -> Cleared BEFORE `emit` runs, so a throwing callback cannot leave a stale window behind that
  //    would swallow the next burst's first `threshold` events.
  pending.delete(key)
  clearTimeout(entry.timer)
  const suppressed = entry.total - entry.threshold
  if (suppressed < 1) {
    return
  }
  try {
    entry.emit({ key, total: entry.total, suppressed, windowMs: entry.windowMs })
  } catch {
    // -> A throw inside a `setTimeout` callback is an `uncaughtException` and ends the process, and
    //    there is nothing to report it to — reporting IS what just failed.
  }
}

/**
 * Returns `true` for the first `threshold` events in a window — log those as themselves — and
 * `false` for every one after. When the window closes, `emit` is called once, and only if anything
 * was actually folded.
 *
 * The window opens on the first event for a key and closes `windowMs` later; it is not extended by
 * activity. The most recent call's `emit` wins, so a summary reports the context of the last event
 * folded into it rather than a stale first one.
 *
 * A non-positive or non-finite `windowMs` turns coalescing off: a misconfigured window should
 * produce a log that says too much, rather than one that quietly says nothing.
 */
export function coalesce(
  key: string,
  windowMs: number,
  emit: (summary: CoalesceSummary) => void,
  { threshold = DEFAULT_COALESCE_THRESHOLD }: CoalesceOptions = {}
): boolean {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return true
  }

  let entry = pending.get(key)
  if (!entry) {
    const timer = setTimeout(() => flush(key), windowMs)
    timer.unref?.()
    entry = { total: 0, timer, windowMs, threshold, emit }
    pending.set(key, entry)
  }
  entry.emit = emit
  entry.total += 1

  return entry.total <= entry.threshold
}

/** For tests only, which share the module-level map across cases. Drops without emitting. */
export function resetCoalesce(key?: string): void {
  if (key !== undefined) {
    const entry = pending.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(key)
    }
    return
  }
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
  }
  pending.clear()
}
