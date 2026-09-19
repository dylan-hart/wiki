import { CustomError } from './common.ts'

/**
 * `--disable-dev-shm-usage` always: a container's default `/dev/shm` is far smaller than Chromium
 * expects, which crashes it on a heavy page.
 *
 * `--no-sandbox` only by opt-in (`security.allowPuppeteerNoSandbox`): it drops Chromium's own
 * process sandbox, and the browser is fed attacker-influenced content (page markdown, block
 * components, a POST-body Mermaid source). The production image under a plain `docker run` cannot
 * initialize that sandbox, so every launch fails until an operator applies a remedy from
 * `docs/decisions/sandboxed-puppeteer-requires-runtime-flags.md`.
 */
export function getPuppeteerLaunchArgs(): string[] {
  const args = ['--disable-dev-shm-usage']
  if (CARDINAL.config.security.allowPuppeteerNoSandbox) {
    CARDINAL.logger.warn(
      'render',
      "launching Puppeteer with --no-sandbox, which disables Chromium's own process sandbox for " +
        'every page render, PDF export and diagram render this instance performs',
      { setting: 'security.allowPuppeteerNoSandbox' }
    )
    args.push('--no-sandbox')
  }
  return args
}

/**
 * Process-wide ceiling across every caller. Deliberately small: each browser is hundreds of MB, and
 * a handful of concurrent launches could otherwise OOM-kill the process.
 */
export const MAX_CONCURRENT_BROWSERS = 2

/**
 * Bounded so a burst fails fast (503) once the queue is deep, rather than every caller hanging on a
 * promise that might take minutes to settle.
 */
export const MAX_QUEUED_LAUNCHES = 8

let activeLaunches = 0

const queuedLaunches: Array<() => void> = []

export function resetLaunchSemaphoreForTests(): void {
  activeLaunches = 0
  queuedLaunches.length = 0
}

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

function releaseLaunchSlot(): void {
  activeLaunches--
  const next = queuedLaunches.shift()
  if (next) {
    next()
  }
}

/**
 * The claimed slot is released exactly once — on a launch failure, or the first time the returned
 * browser's `close()` is called. Split from `launchPuppeteerBrowser` so a test can drive the
 * semaphore with a stubbed `launch`, without the real `puppeteer` package.
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
 * Puppeteer is an operator-installed extension, so the import is dynamic and by non-literal
 * specifier — a literal `import 'puppeteer'` would not typecheck without the package present. A
 * load failure is recorded via `extensions.noteLoadFailure`, so a later reinstall can tell the
 * operator a restart is needed.
 *
 * The production image runs Debian's `chromium` package (`PUPPETEER_EXECUTABLE_PATH`), not the
 * build `puppeteer` downloads, so `puppeteer`'s pinned CDP target has to stay close to that
 * Chromium's version or `page.goto()` fails with `net::ERR_INVALID_ARGUMENT`. Re-check the pairing
 * before bumping the dependency: `docs/decisions/2026-09-14-puppeteer-chromium-protocol-pin.md`.
 *
 * `errorName` is per caller, so a client can tell a render failure from an export failure.
 */
export async function launchPuppeteerBrowser(errorName: string): Promise<any> {
  const specifier = 'puppeteer'
  let puppeteer: any
  try {
    ;({ default: puppeteer } = await import(specifier))
  } catch (err: any) {
    CARDINAL.models.extensions.noteLoadFailure(specifier)
    throw new CustomError(errorName, `Could not load the Puppeteer extension: ${err.message}`, 503)
  }

  return launchUnderSemaphore(errorName, () =>
    puppeteer.launch({
      headless: true,
      args: getPuppeteerLaunchArgs()
    })
  )
}

export async function isPuppeteerAvailable(): Promise<boolean> {
  const definition = CARDINAL.models.extensions.getDefinition('puppeteer')
  return Boolean(definition) && (await CARDINAL.models.extensions.isInstalled(definition!))
}

/**
 * Ask before queueing work or launching a browser: a missing extension is then a clean 503 the
 * client can act on, not a launch left to fail on its own terms.
 */
export async function assertPuppeteerAvailable(errorName: string, message: string): Promise<void> {
  if (!(await isPuppeteerAvailable())) {
    throw new CustomError(errorName, message, 503)
  }
}

/**
 * The last act of an attempt that already has its result or its own failure, neither of which a
 * failure to close should replace. Accepts null/undefined so a `finally` can call it for a browser
 * that never opened.
 */
export async function closeQuietly(
  closable: { close(): Promise<unknown> } | null | undefined,
  label: string
): Promise<void> {
  try {
    await closable?.close()
  } catch (err: any) {
    CARDINAL.logger.debug('render', 'could not close cleanly', { subject: label, error: err })
  }
}
