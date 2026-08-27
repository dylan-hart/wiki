import { CustomError } from './common.ts'

/**
 * Browser flags every headless launch in this codebase uses, so a page re-render and a PDF export
 * behave identically as far as the browser they run in is concerned.
 *
 * `--disable-dev-shm-usage` because a container's default `/dev/shm` is far smaller than Chromium
 * expects, which otherwise crashes it on a page heavy enough to need more shared memory than that.
 *
 * `--no-sandbox` is deliberately **not** included by default: it disables Chromium's own process
 * sandbox, so a renderer-process exploit escapes straight to this process's own privileges. Two of
 * the three call sites feed the browser attacker-influenced content (`pdfExport` drives the live SPA
 * page view under the requester's own session; `diagramRender` mounts a POST-body Mermaid source), so
 * a sandboxed launch is the safer default. It exists only as an opt-in fallback
 * (`WIKI.config.rendering.puppeteerNoSandbox`) for a host that genuinely cannot start Chromium's
 * sandbox — a container without the setuid sandbox helper or unprivileged user namespaces enabled.
 * See `docs/variances.md` for this instance's posture.
 */
export const BASE_PUPPETEER_LAUNCH_ARGS = ['--disable-dev-shm-usage']

/**
 * The launch args to actually use, honouring the `--no-sandbox` opt-in fallback. Logs loudly at warn
 * level when the fallback is taken, so an operator notices it's on rather than discovering it only
 * when reading source.
 */
export function getPuppeteerLaunchArgs(): string[] {
  if (WIKI.config.rendering?.puppeteerNoSandbox) {
    WIKI.logger.warn(
      'Launching headless Chromium with --no-sandbox (rendering.puppeteerNoSandbox is enabled). ' +
        "This disables Chromium's own process sandbox — only use this on a host that cannot start " +
        'the sandbox otherwise. See docs/variances.md.'
    )
    return [...BASE_PUPPETEER_LAUNCH_ARGS, '--no-sandbox']
  }
  return [...BASE_PUPPETEER_LAUNCH_ARGS]
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
    args: getPuppeteerLaunchArgs()
  })
}
