import { CustomError } from '../helpers/common.ts'
import {
  assertPuppeteerAvailable,
  closeQuietly,
  isPuppeteerAvailable,
  launchPuppeteerBrowser
} from '../helpers/puppeteer.ts'
import { withTimeout } from '../helpers/timeout.ts'
import { sessionCookieName } from '../helpers/security.ts'

const EXPORT_NAVIGATION_TIMEOUT = 30000

/**
 * Bounded rather than looping forever, so one block stuck re-rendering itself (an infinite
 * animation driven through `requestUpdate`, say) cannot hold the export open on its own.
 * `EXPORT_SETTLE_TIMEOUT` is the coarser half of the same guard.
 */
const EXPORT_SETTLE_MAX_ROUNDS = 20

const EXPORT_SETTLE_TIMEOUT = 15000

const EXPORT_PDF_TIMEOUT = 30000

export interface PdfExportRequest {
  /** Travels as a spoofed `Host` header, not as the URL puppeteer connects to. */
  hostname: string
  /** This instance's own port, i.e. `CARDINAL.config.port`. */
  port: number
  /** The page's own path; empty string for the home page. */
  path: string
  /**
   * The requester's own session cookie value, forwarded so the headless browser sees exactly the
   * page they may. The API route requires a logged-in actor before this is ever called, so absent
   * here means a personal-access-token caller with no session cookie to forward, not an anonymous
   * one.
   */
  sessionCookie?: string | null
}

/**
 * Runs inside the headless browser via `page.evaluate(blockSettleScript, maxRounds)`.
 *
 * `networkidle0` — waited for by `exportPdf` before this ever runs — is not enough on its own: a
 * block like `block-diagram` draws its Mermaid diagram in pure JS after it mounts, which is CPU work
 * and not a network request, so the page can go network-idle with a diagram still blank. Lit's
 * `updateComplete` resolves `true` when the element queued a further update while it was being
 * awaited, `false` once it is genuinely settled.
 *
 * A plain, named, parameterized function rather than a closure: Puppeteer serializes this to a
 * string and re-evaluates it inside the page's own realm, so it can capture nothing from this
 * module and `maxRounds` has to travel as a real `page.evaluate` argument. Every DOM global is read
 * off `globalThis` because the backend's `tsconfig.json` has no `dom` lib.
 */
export async function blockSettleScript(maxRounds: number): Promise<void> {
  const doc = (globalThis as any).document
  const registry = (globalThis as any).customElements
  const isBlock = (el: any) =>
    typeof el.tagName === 'string' && el.tagName.toLowerCase().startsWith('block-')

  const undefinedTags = new Set(
    Array.from(doc.querySelectorAll(':not(:defined)'))
      .filter(isBlock)
      .map((el: any) => el.tagName.toLowerCase())
  )
  await Promise.all([...undefinedTags].map((tag) => registry.whenDefined(tag)))

  for (let round = 0; round < maxRounds; round++) {
    /*
      `in` rather than a read: the check only needs the property to exist, and `in` does not invoke
      its getter. Reading it is what starts riding a promise — done once per element per round, in
      the `Promise.all` below.
    */
    const elements = Array.from(doc.querySelectorAll('*')).filter(
      (el: any) => isBlock(el) && 'updateComplete' in el
    )
    if (elements.length === 0) {
      return
    }
    const stillUpdating = await Promise.all(elements.map((el: any) => el.updateComplete))
    if (!stillUpdating.some(Boolean)) {
      return
    }
  }
}

/**
 * Drives Puppeteer against this instance's own live page view — the SPA route a reader's browser
 * would land on — rather than the bare `/_render` shell `models/renderQueue.ts` uses. `/_render`
 * hosts nothing but the markdown-to-HTML pipeline: no stylesheet, no theme, no block components,
 * and a PDF export is a reader-facing artifact.
 *
 * One browser is opened and closed per export, with no queue of its own: this is a low-frequency,
 * user-initiated request rather than a background job, so `Rendering.drainQueue`'s reuse is
 * deliberately not copied until exports are shown to pile up on the shared concurrency ceiling
 * `helpers/puppeteer.ts` enforces.
 */
class PdfExport {
  /**
   * Asked independently of `Rendering.isAvailable`: a distinct capability with its own error name,
   * which happens to need the same extension installed.
   */
  async isAvailable(): Promise<boolean> {
    return isPuppeteerAvailable()
  }

  /**
   * Asked before a browser is ever opened, so a missing extension is a clean 503 rather than a
   * browser launch left to fail on its own terms.
   */
  async ensureCanExport(): Promise<void> {
    await assertPuppeteerAvailable(
      'exportPuppeteerMissing',
      'Exporting a page to PDF needs the Puppeteer extension, which is not installed.'
    )
  }

  /**
   * AUTH: the exported page may not be public, so the headless browser needs the requester's own
   * session rather than an anonymous one. The forwarded cookie value is already exactly what
   * `@fastify/session` signs and reads back — `@fastify/cookie` parses cookies into name/value
   * pairs and never unsigns one unless asked — so the session hook this instance already runs on
   * every request reads it back as it would from the original browser, permissions included. A
   * short-lived render token would work too, but costs an endpoint, a one-time store and an expiry
   * policy for the same outcome; the cookie is scoped to `127.0.0.1` on this process's own port and
   * dies with the browser at the end of this request.
   *
   * HOSTNAME: puppeteer always connects to `127.0.0.1:${port}`, never to `hostname` itself, which
   * may not even resolve from this process (a custom domain pointed at a load balancer in front of
   * it). Which site answers is decided by this instance's own hostname→site mapping, read off
   * `req.hostname`, so the caller's hostname travels as a spoofed `Host` header instead.
   */
  async exportPdf(request: PdfExportRequest): Promise<Buffer> {
    await this.ensureCanExport()

    const browser = await this.launchBrowser()
    try {
      const page = await browser.newPage()

      if (request.sessionCookie) {
        // -> `secure: true` even though puppeteer connects over plain `http://`: the session
        //    cookie's `__Host-` prefix makes Chromium's cookie store enforce the `Secure` rule at
        //    the store level, CDP's `Network.setCookie` included, so omitting it drops the cookie
        //    outright and silently exports the page as if anonymous. Safe over `http://` because
        //    `127.0.0.1` is a potentially-trustworthy origin for `Secure` cookies whatever the
        //    scheme.
        await page.setCookie({
          name: sessionCookieName(),
          value: request.sessionCookie,
          url: `http://127.0.0.1:${request.port}`,
          httpOnly: true,
          secure: true
        })
      }

      await page.setExtraHTTPHeaders({ Host: request.hostname })

      await page.goto(`http://127.0.0.1:${request.port}/${encodeURI(request.path)}`, {
        waitUntil: 'networkidle0',
        timeout: EXPORT_NAVIGATION_TIMEOUT
      })

      await this.waitForBlocksToSettle(page)

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        timeout: EXPORT_PDF_TIMEOUT
      })
      return Buffer.from(pdf)
    } finally {
      await this.discardBrowser(browser)
    }
  }

  /**
   * `page.evaluate` has no timeout of its own, and what it runs here is somebody else's async
   * component code: a block stuck re-rendering itself would otherwise hold this export open
   * indefinitely.
   */
  private async waitForBlocksToSettle(page: any): Promise<void> {
    await withTimeout(
      page.evaluate(blockSettleScript, EXPORT_SETTLE_MAX_ROUNDS),
      EXPORT_SETTLE_TIMEOUT,
      () =>
        new CustomError(
          'exportSettleTimeout',
          `The page's diagrams and other async content did not settle within ${EXPORT_SETTLE_TIMEOUT / 1000} seconds.`,
          504
        )
    )
  }

  /** Broken out so a test can mock the one call that reaches outside the process. */
  private async launchBrowser(): Promise<any> {
    return launchPuppeteerBrowser('exportPuppeteerMissing')
  }

  /**
   * A close failure must not replace the export's own outcome: by here it either has its PDF or has
   * already failed for its own reason.
   */
  private async discardBrowser(browser: any): Promise<void> {
    await closeQuietly(browser, 'export browser')
  }
}

export const pdfExport = new PdfExport()
