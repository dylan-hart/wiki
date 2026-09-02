/**
 * Race a promise against a timer, so work that has no ceiling of its own gets one.
 *
 * The eight places that hand-rolled this — the scheduler's worker/in-process task races and its
 * shutdown drain, the render/diagram/PDF Puppeteer steps, the search engine init — all wrote the
 * same block: a `setTimeout` rejecting into a `Promise.race`, with a `clearTimeout` in a `finally`
 * so a fast success does not leave a timer holding the event loop open. What differed between them
 * was only the error to fail with, which is why that is a callback rather than a message: each call
 * site keeps its own `CustomError` name/status (or plain `Error`), and the error is not even
 * constructed unless the timer actually wins.
 *
 * The work itself is never cancelled — nothing here can cancel a `page.evaluate` or a worker thread.
 * Losing the race means the caller stops waiting, and whatever it was waiting on carries on until it
 * finishes or the process ends; every call site is written against that (see `core/scheduler.ts`'s
 * `executeInProcess` for the fullest treatment of a "stale" continuation outliving its ceiling).
 *
 * @param onExpire Builds the rejection reason, called only when the timer wins
 * @param opts.unref Leaves the timer unreferenced, for a ceiling that must not by itself keep the
 *   process alive — what a shutdown drain needs, since it runs as the process is trying to exit
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
