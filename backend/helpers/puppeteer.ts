import { CustomError } from './common.ts'

/**
 * Browser flags every headless launch in this codebase uses, so a page re-render and a PDF export
 * behave identically as far as the browser they run in is concerned.
 *
 * `--no-sandbox` because this runs as a background service — typically containerized, often without
 * the setuid sandbox helper Chromium's own sandbox needs — and `--disable-dev-shm-usage` because a
 * container's default `/dev/shm` is far smaller than Chromium expects, which otherwise crashes it on
 * a page heavy enough to need more shared memory than that.
 */
export const PUPPETEER_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage']

/**
 * Process-wide ceiling on how many headless browsers may be open at once, across every caller
 * (`models/pdfExport.ts`, `models/diagramRender.ts`, `models/rendering.ts`) — each Chromium process
 * costs hundreds of MB, and the export route's own guard (`helpers/rateLimit.ts`'s `limitRenders`) is
 * a *window* count, not a concurrency limit, so nothing else in the request path stops N simultaneous
 * callers from opening N browsers. Deliberately small and fixed rather than configurable: the failure
 * mode past it (a 503, below) is meant to be common enough under load to prove the ceiling is doing
 * its job, not tuned away.
 */
export const MAX_CONCURRENT_BROWSERS = 2

/**
 * How many callers may queue behind a full ceiling before a new one is refused outright. Bounded, not
 * unbounded, so a burst of requests past both the ceiling and this queue fails fast (503) instead of
 * piling up waiters that all eventually time out anyway — an unbounded queue would just move the
 * resource exhaustion from "too many browsers" to "too many pending requests".
 */
export const MAX_QUEUED_LAUNCHES = 4

/** Number of browser slots currently held. Module-level: shared by every caller in this process. */
let activeBrowsers = 0

/** FIFO of callers waiting for a slot, each woken by `releaseBrowserSlot` in the order they queued. */
const waitQueue: Array<() => void> = []

/**
 * Acquire one of the process-wide browser slots defined above, queueing (bounded by
 * `MAX_QUEUED_LAUNCHES`) if none are free right now.
 *
 * @param errorName Threaded through so a rejection past the waiter bound carries the same
 *   caller-specific `CustomError` name a load or launch failure would.
 */
async function acquireBrowserSlot(errorName: string): Promise<void> {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++
    return
  }
  if (waitQueue.length >= MAX_QUEUED_LAUNCHES) {
    throw new CustomError(
      errorName,
      'Too many headless browser launches are already in progress or queued; try again shortly.',
      503
    )
  }
  await new Promise<void>((resolve) => {
    waitQueue.push(() => {
      activeBrowsers++
      resolve()
    })
  })
}

/** Release a process-wide browser slot, waking the next queued waiter (if any) to take it. */
function releaseBrowserSlot(): void {
  activeBrowsers--
  const next = waitQueue.shift()
  if (next) {
    next()
  }
}

/**
 * Run `launch` inside the process-wide semaphore that bounds concurrent headless browsers (see the
 * constants above). Broken out from `launchPuppeteerBrowser` so a test can drive the gating logic
 * itself against a stub launcher, without touching the real dynamic `import('puppeteer')` — the
 * same "break it out so a test can mock it" shape `models/pdfExport.ts#launchBrowser` and
 * `models/diagramRender.ts#launchBrowser` already use for the browser-launch step itself.
 *
 * The slot is released on a failed `launch()` (so a browser that never opened does not leak a slot
 * nobody will ever return), and again exactly once when the launched value's own `close()` is called
 * — wrapped here rather than left to each caller, since every caller already calls `close()` on
 * whatever this resolves to as part of its own cleanup.
 */
export async function runWithBrowserSlot<T extends { close: (...args: any[]) => Promise<any> }>(
  errorName: string,
  launch: () => Promise<T>
): Promise<T> {
  await acquireBrowserSlot(errorName)

  let released = false
  const release = () => {
    if (released) {
      return
    }
    released = true
    releaseBrowserSlot()
  }

  let result: T
  try {
    result = await launch()
  } catch (err) {
    release()
    throw err
  }

  const originalClose = result.close.bind(result)
  result.close = (async (...args: any[]) => {
    try {
      return await originalClose(...args)
    } finally {
      release()
    }
  }) as T['close']

  return result
}

/**
 * Load Puppeteer and open a browser with this instance's standard flags.
 *
 * Puppeteer is an extension the operator installs, not a declared dependency of the backend, so the
 * import is dynamic and by specifier rather than literal — a literal `import 'puppeteer'` would not
 * typecheck without the package present. A failure to load it here is recorded via
 * `extensions.noteLoadFailure`, so that a later reinstall can tell the operator a restart is needed
 * rather than claim the extension is ready to use in a process that already tried and failed to load
 * its module.
 *
 * Shared by `models/rendering.ts` (re-rendering a page's markdown from a headless shell) and
 * `models/pdfExport.ts` (driving the live page view to produce a PDF) — two different reasons to open
 * a browser that should still open the exact same browser.
 *
 * The actual launch runs inside `runWithBrowserSlot`, a process-wide bounded semaphore: every caller
 * funnels through this one function, so it is the single gate that keeps the number of simultaneously
 * open Chromium processes bounded regardless of how many requests ask for one at once. A caller past
 * the ceiling and its (bounded) waiter queue gets a 503 back rather than an indefinitely pending
 * launch — see `MAX_CONCURRENT_BROWSERS`/`MAX_QUEUED_LAUNCHES` above.
 *
 * @param errorName The `CustomError` name to fail with. Each caller has its own, so a client can tell
 *   a render failure from an export failure apart despite both sharing this one cause.
 */
export async function launchPuppeteerBrowser(errorName: string): Promise<any> {
  // -> Held in a variable for the same reason the specifier is dynamic: nothing here may resolve at
  //    typecheck time
  const specifier = 'puppeteer'
  let puppeteer: any
  try {
    ;({ default: puppeteer } = await import(specifier))
  } catch (err: any) {
    WIKI.models.extensions.noteLoadFailure(specifier)
    throw new CustomError(errorName, `Could not load the Puppeteer extension: ${err.message}`, 503)
  }

  return runWithBrowserSlot(errorName, () =>
    puppeteer.launch({
      headless: true,
      args: PUPPETEER_LAUNCH_ARGS
    })
  )
}
