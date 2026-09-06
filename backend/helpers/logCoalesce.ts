/**
 * Fold a burst of identical-in-kind log events into one summary line.
 *
 * The problem this exists for: a credential-guessing run against one address produces one refusal
 * per attempt, and a log that prints every one of them buries everything else that happened while
 * it ran. Printing none of them is worse — the first few are how an operator learns the run is
 * happening at all. So the first few go through as themselves and the rest are counted, with one
 * line at the end of the window saying how many there were.
 *
 * Deliberately knows nothing about authentication, rate limits, or the `WIKI` global: it takes a
 * key, a window and a callback, and every decision about what a line SAYS belongs to the caller.
 * That is what lets `models/login.ts`'s refusals, `helpers/rateLimit.ts`'s bans and (OpenProject
 * #2675) the mail model's delivery failures share one implementation rather than three.
 *
 * At most one pending summary is held per key — a counter and a timer, nothing about the events
 * themselves — and the timer is `unref()`ed, so a pending summary never keeps the process alive
 * past a shutdown that would otherwise have ended it.
 */

/**
 * What {@link coalesce} hands its `emit` callback when a window closes with events left folded into
 * it.
 *
 * `total` counts EVERY event seen in the window, the ones that were emitted individually included —
 * it is the number an operator wants ("twenty attempts from this address"), not the remainder. The
 * remainder is `suppressed`, for a caller that would rather phrase it as "and N more".
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
   *
   * Three by default: enough for an operator tailing the log to see the shape of what is starting
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
    // -> This runs inside a `setTimeout` callback, where a throw is an `uncaughtException` and ends
    //    the process. A logging helper must not be able to do that, and there is nothing to report
    //    it to from here — reporting IS what just failed.
  }
}

/**
 * Count one event against `key`'s current window and say whether the caller should log it.
 *
 * Returns `true` for the first `threshold` events in a window — log those as themselves — and
 * `false` for every one after, which is folded into a summary instead. When the window closes,
 * `emit` is called once with a {@link CoalesceSummary}, and only if anything was actually folded:
 * a window that never passed the threshold has already said everything it had to say.
 *
 * The window opens on the first event for a key and closes `windowMs` later, whether or not more
 * arrive; it is not extended by activity. The next event after it closes opens a fresh one.
 *
 * `emit` is remembered per window and the most recent call's callback wins, so a summary reports
 * the context of the last event folded into it rather than a stale first one.
 *
 * A non-positive or non-finite `windowMs` turns coalescing off for that call: every event answers
 * `true` and nothing is ever scheduled. That is the honest behaviour for a misconfigured window —
 * a log that says too much, rather than one that quietly says nothing.
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

/**
 * Drop pending windows without emitting their summaries — one key, or all of them.
 *
 * For tests, which share this module-level map across cases the way `helpers/rateLimit.ts`'s
 * `activeBanMemo` is shared, and for nothing else: production has no reason to discard a summary
 * it has already decided to hold.
 */
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
