import { CustomError } from './common.ts'

/**
 * Browser flags every headless launch in this codebase uses, so a page re-render and a PDF export
 * behave identically as far as the browser they run in is concerned.
 *
 * `--disable-dev-shm-usage` is always included: a container's default `/dev/shm` is far smaller than
 * Chromium expects, which otherwise crashes it on a page heavy enough to need more shared memory than
 * that.
 *
 * `--no-sandbox` is NOT included by default. It drops Chromium's own process sandbox, which matters
 * here because two of the three callers feed the browser attacker-influenced content: `pdfExport`
 * drives the live SPA page view with the requester's own session cookie (so page markdown and block
 * components execute), and `diagramRender.renderMermaid` mounts `block-diagram` around a POST-body
 * Mermaid source. An operator
 * whose deployment environment cannot give Chromium its own sandbox (typically a container without
 * the setuid sandbox helper) opts into it via `security.allowPuppeteerNoSandbox` — see
 * `docs/variances.md` for the posture this default was chosen against.
 */
export function getPuppeteerLaunchArgs(): string[] {
  const args = ['--disable-dev-shm-usage']
  if (WIKI.config.security.allowPuppeteerNoSandbox) {
    WIKI.logger.warn(
      'Launching Puppeteer with --no-sandbox (security.allowPuppeteerNoSandbox is enabled). This disables ' +
        "Chromium's own process sandbox for every page render, PDF export and diagram render this instance performs."
    )
    args.push('--no-sandbox')
  }
  return args
}

/**
 * How many headless Chromium processes this instance ever allows in flight at once, across every
 * caller (page re-render, PDF export, diagram render) and every request source — module-level state,
 * not per-model-instance, so it is a genuine process-wide ceiling. Deliberately small: each browser is
 * hundreds of MB, and the previous absence of any cap (OpenProject #2258/#2259) meant a handful of
 * concurrent requests could OOM-kill the whole process.
 */
export const MAX_CONCURRENT_BROWSERS = 2

/**
 * How many launch attempts may queue behind the ceiling above before a new one is refused outright.
 * Bounded rather than unbounded so a burst of requests fails fast (503) once the queue is already
 * deep, instead of every caller hanging indefinitely on a promise that might take minutes to settle.
 */
export const MAX_QUEUED_LAUNCHES = 8

/** How many browsers are currently open, counted from a successful launch until its `close()`. */
let activeLaunches = 0

/** FIFO of resolvers for launches waiting on a slot, each capped by `MAX_QUEUED_LAUNCHES`. */
const queuedLaunches: Array<() => void> = []

/**
 * Test-only: resets this module's semaphore state to empty. `puppeteer.test.ts` calls this between
 * tests so one test's in-flight (or deliberately never-resolved) launches cannot leak into the next
 * — there is no production caller.
 */
export function resetLaunchSemaphoreForTests(): void {
  activeLaunches = 0
  queuedLaunches.length = 0
}

/**
 * Blocks until a launch slot is free, claiming it before returning. Throws a 503 `CustomError`
 * immediately, without waiting, once the queue behind the ceiling is already at `MAX_QUEUED_LAUNCHES`
 * — a bounded wait, not an unbounded one.
 */
function acquireLaunchSlot(errorName: string): Promise<void> {
  if (activeLaunches < MAX_CONCURRENT_BROWSERS) {
    activeLaunches++
    return Promise.resolve()
  }
  if (queuedLaunches.length >= MAX_QUEUED_LAUNCHES) {
    throw new CustomError(
      errorName,
      'Too many browser renders are already in progress. Please try again shortly.',
      503
    )
  }
  return new Promise<void>((resolve) => {
    queuedLaunches.push(() => {
      activeLaunches++
      resolve()
    })
  })
}

/** Frees the current caller's slot and, if anyone is queued, immediately hands it to the next. */
function releaseLaunchSlot(): void {
  activeLaunches--
  const next = queuedLaunches.shift()
  if (next) {
    next()
  }
}

/**
 * Runs `launch` under this module's process-wide semaphore, and arranges for the slot it claims to
 * be released exactly once — on a launch failure, or otherwise the first time the returned browser's
 * `close()` is called. Broken out from `launchPuppeteerBrowser` below purely so `puppeteer.test.ts`
 * can drive the semaphore directly with a stubbed `launch`, without needing the real `puppeteer`
 * package (or Node module-mocking) to exercise it.
 *
 * @param errorName The `CustomError` name a rejected-for-being-over-capacity caller fails with.
 * @param launch Opens the actual browser, e.g. `puppeteer.launch(...)`.
 */
export async function launchUnderSemaphore(
  errorName: string,
  launch: () => Promise<any>
): Promise<any> {
  await acquireLaunchSlot(errorName)

  let browser: any
  try {
    browser = await launch()
  } catch (err: any) {
    releaseLaunchSlot()
    throw err
  }

  const originalClose = browser.close?.bind(browser)
  let released = false
  const releaseOnce = () => {
    if (!released) {
      released = true
      releaseLaunchSlot()
    }
  }
  browser.close = async (...args: any[]) => {
    try {
      return originalClose ? await originalClose(...args) : undefined
    } finally {
      releaseOnce()
    }
  }

  return browser
}

/**
 * Load Puppeteer and open a browser with this instance's standard flags, under the process-wide
 * concurrency ceiling above.
 *
 * Puppeteer is an extension the operator installs, not a declared dependency of the backend, so the
 * import is dynamic and by specifier rather than literal — a literal `import 'puppeteer'` would not
 * typecheck without the package present. A failure to load it here is recorded via
 * `extensions.noteLoadFailure`, so that a later reinstall can tell the operator a restart is needed
 * rather than claim the extension is ready to use in a process that already tried and failed to load
 * its module.
 *
 * Shared by `models/renderQueue.ts` (re-rendering a page's markdown from a headless shell),
 * `models/pdfExport.ts` (driving the live page view to produce a PDF) and `models/diagramRender.ts`
 * (drawing a Mermaid diagram) — three different reasons to open a browser that should still open the
 * exact same browser, and all three funnel through the one semaphore here.
 *
 * @param errorName The `CustomError` name to fail with. Each caller has its own, so a client can tell
 *   a render failure from an export failure apart despite both sharing this one cause. Also the name
 *   a caller rejected for being over the concurrency ceiling fails with.
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

  return launchUnderSemaphore(errorName, () =>
    puppeteer.launch({
      headless: true,
      args: getPuppeteerLaunchArgs()
    })
  )
}

/**
 * Whether the Puppeteer extension is installed on this instance.
 *
 * Puppeteer is an operator-installed extension rather than a declared dependency, so every feature
 * that needs a browser has to ask first — page re-rendering, PDF export and Mermaid diagram
 * rendering each asked with a byte-identical two-liner of their own. One question, one answer.
 */
export async function isPuppeteerAvailable(): Promise<boolean> {
  const definition = WIKI.models.extensions.getDefinition('puppeteer')
  return Boolean(definition) && (await WIKI.models.extensions.isInstalled(definition!))
}

/**
 * Refuse the caller, with their own error name and message, when no browser can be opened here.
 *
 * Asked before any work is queued or a browser is launched: a missing extension is a clean 503 the
 * client can act on, not a launch left to fail on its own terms. The name and message stay per
 * caller — a client can tell a failed page render from a failed export from a failed diagram — which
 * is the whole of what differed between the three copies of this.
 */
export async function assertPuppeteerAvailable(errorName: string, message: string): Promise<void> {
  if (!(await isPuppeteerAvailable())) {
    throw new CustomError(errorName, message, 503)
  }
}

/**
 * Close a browser (or anything else with a `close()`), and keep any trouble doing so to itself.
 *
 * Always the last act of a render/export/diagram attempt, which by then either has its result or has
 * already failed for its own reason — neither should be replaced by a failure to hang up. Accepts a
 * null/undefined closable so a `finally` can call it against a browser that never opened.
 *
 * @param label What is being closed, for the debug line: "Could not close the <label> cleanly: ..."
 */
export async function closeQuietly(
  closable: { close(): Promise<unknown> } | null | undefined,
  label: string
): Promise<void> {
  try {
    await closable?.close()
  } catch (err: any) {
    WIKI.logger.debug(`Could not close the ${label} cleanly: ${err.message}`)
  }
}
