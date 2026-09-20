/**
 * Race a promise against a timer, so work that has no ceiling of its own gets one. `onExpire` is a
 * callback rather than a message so each caller keeps its own error type, built only when the timer
 * wins.
 *
 * The work itself is never cancelled — nothing here can cancel a `page.evaluate` or a worker thread.
 * Losing the race means the caller stops waiting, and the work carries on until it finishes or the
 * process ends.
 *
 * @param opts.unref Leaves the timer unreferenced, for a ceiling that must not by itself keep the
 *   process alive — what a shutdown drain needs
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onExpire: () => Error,
  opts?: { unref?: boolean }
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onExpire()), ms)
    if (opts?.unref) {
      timer.unref?.()
    }
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}
