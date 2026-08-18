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

  return puppeteer.launch({
    headless: true,
    args: PUPPETEER_LAUNCH_ARGS
  })
}
