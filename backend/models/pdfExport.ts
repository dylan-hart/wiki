import { CustomError } from '../helpers/common.ts'
import {
  assertPuppeteerAvailable,
  closeQuietly,
  isPuppeteerAvailable,
  launchPuppeteerBrowser
} from '../helpers/puppeteer.ts'
import { withTimeout } from '../helpers/timeout.ts'
import { sessionCookieName } from '../helpers/security.ts'

/** How long the live page view gets to finish loading before giving up, in milliseconds. */
const EXPORT_NAVIGATION_TIMEOUT = 30000

/**
 * How many rounds `blockSettleScript` polls Lit's `updateComplete` before giving up on a block that
 * never settles. Bounded rather than looping forever, so one block stuck re-rendering itself (an
 * infinite animation driven through `requestUpdate`, say) cannot hold the export open on its own —
 * `EXPORT_SETTLE_TIMEOUT` below is the other, coarser half of that guard.
 */
const EXPORT_SETTLE_MAX_ROUNDS = 20

/** How long the whole block-settle wait gets, in milliseconds — this instance's RENDER_TIMEOUT. */
const EXPORT_SETTLE_TIMEOUT = 15000

/** How long `page.pdf()` itself gets, in milliseconds. */
const EXPORT_PDF_TIMEOUT = 30000

export interface PdfExportRequest {
  /**
   * The hostname this instance's own live page view should be asked for under — see the comment on
   * `exportPdf` for why this travels as a spoofed `Host` header rather than as the URL puppeteer
   * connects to.
   */
  hostname: string
  /** This instance's own port, i.e. `WIKI.config.port` — puppeteer always connects over loopback. */
  port: number
  /** The page's own path, e.g. `getting-started`. Empty string for the home page. */
  path: string
  /**
   * The requester's `SESSION_COOKIE_NAME` (`__Host-wikiSession`) cookie value, forwarded so the
   * headless browser sees exactly the page they may. The API route requires a logged-in actor before
   * this is ever called (OpenProject #2258/#2262), so `null`/absent here means a
   * personal-access-token caller (no session cookie to forward), not an anonymous one.
   */
  sessionCookie?: string | null
}

/**
 * Runs inside the headless browser via `page.evaluate(blockSettleScript, maxRounds)`.
 *
 * `networkidle0` — waited for by `exportPdf` before this ever runs — is not enough on its own: a
 * block like `block-diagram` draws its Mermaid diagram in pure JS after it mounts, which is CPU work
 * and not a network request, so the page can go network-idle with a diagram still blank.
 *
 * This waits, in order, for every block custom element the page contains to finish upgrading — the
 * `:not(:defined)` selector is the same one `Index.vue` scans to know which block bundles to fetch —
 * and then rides out Lit's own `updateComplete` promise on each of them until none of them asks for
 * another round: `updateComplete` resolves `true` when the element queued a further update while this
 * one was being waited on, `false` when it is genuinely settled.
 *
 * A plain, named, parameterized function rather than a closure: Puppeteer serializes this to a string
 * and re-evaluates it inside the page's own realm, so it cannot close over anything from this module —
 * `maxRounds` has to travel as a real `page.evaluate` argument, not a captured variable — and every
 * DOM/custom-element global is read off `globalThis` rather than named directly, since the backend's
 * `tsconfig.json` has no `dom` lib and this file is typechecked as ordinary Node code even though this
 * one function never runs there. The indirection also means it can be exercised directly in a test
 * with a stubbed `globalThis.document` / `globalThis.customElements` — see `pdfExport.test.ts`.
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
      `'updateComplete' in el` rather than reading it here: the check only needs to know the property
      exists, and `in` does not invoke its getter. Reading it is what starts riding a promise — doing
      that once per element per round, in the `Promise.all` below, is what this loop is for.
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
 * PDF export model
 *
 * Exports a page to PDF by driving Puppeteer against this instance's own real, live page view — the
 * SPA route a reader's browser would land on — rather than the bare `/_render` shell
 * `models/renderQueue.ts` uses. `/_render` hosts nothing but the markdown-to-HTML pipeline: no
 * stylesheet, no theme, no block components. A PDF export is a reader-facing artifact, so it has to
 * go through the page reading itself would go through.
 *
 * Shares `helpers/puppeteer.ts` with `models/renderQueue.ts` and `models/diagramRender.ts` for the
 * browser itself (same flags, same `extensions.noteLoadFailure` tracking, and — since OpenProject
 * #2258/#2259 — the same process-wide concurrency ceiling that helper now enforces across all three),
 * but everything past opening a tab is different: there is no renderer bundle to wait on, no queue of
 * its own at this model's own level (this is a low-frequency, user-initiated request rather than a
 * background job, so one browser opened and closed per export is an acceptable starting cost — see
 * `drainQueue` on `Rendering` for the lesson this deliberately does NOT reuse, and the load-testing
 * note on `exportPdf` below for when it would start to), and it needs the requester's own session,
 * since the page it renders may not be public — the API route also now requires the requester be
 * logged in at all before calling this (OpenProject #2262), same as the sibling browser-launching
 * routes.
 *
 * KNOWN CROSS-BRANCH OVERLAP (flagged for merge review, not resolved here): `feature/page-version-export`
 * (Feature 371, task 496) built its own, materially simpler PDF export on a different unmerged branch —
 * it prints the page's already-stored `page.render` HTML in a minimal wrapper, never touching the live
 * SPA or any block component. This model is deliberately the richer version Feature 402's task 669
 * asked for (live page view, waits for Mermaid/PlantUML to settle), but a human has two competing
 * page-PDF-export endpoints to reconcile at merge time.
 */
class PdfExport {
  /**
   * Whether this instance can export a page to PDF at all.
   *
   * Same question `Rendering.isAvailable` asks, independently rather than delegated: PDF export is a
   * distinct capability from server-side rendering (it needs no re-render queue, and fails with its
   * own error name), even though both happen to need the same extension installed.
   */
  async isAvailable(): Promise<boolean> {
    return isPuppeteerAvailable()
  }

  /**
   * Refuse the caller when this instance cannot export a PDF.
   *
   * Asked before a browser is ever opened, the same way `Rendering.ensureCanRender` guards its own
   * work — a missing extension is a clean 503, not a browser launch left to fail on its own terms.
   */
  async ensureCanExport(): Promise<void> {
    await assertPuppeteerAvailable(
      'exportPuppeteerMissing',
      'Exporting a page to PDF needs the Puppeteer extension, which is not installed.'
    )
  }

  /**
   * Render a page's live view to PDF and hand back the bytes.
   *
   * AUTH, worked through and decided here rather than left to a comment elsewhere: the page this
   * exports may not be public, so the headless browser needs the requester's own session, not an
   * anonymous one. Two designs were on the table —
   *
   *   1. Forward the requester's own `SESSION_COOKIE_NAME` (`__Host-wikiSession`) cookie value to
   *      `page.setCookie()`, scoped to this instance's own loopback origin.
   *   2. Mint a short-lived, one-time render token, consumed by a dedicated internal route that trades
   *      it for a session.
   *
   * (1) is what this does. The cookie value handed to the API route is already exactly what
   * `@fastify/session` signs and reads back — `req.cookies[SESSION_COOKIE_NAME]` is the raw,
   * still-signed string, since `@fastify/cookie` only parses cookies into name/value pairs and never
   * unsigns one
   * unless asked — so forwarding it costs nothing to mint and nothing new to verify: the same
   * `onRequest` session hook this instance already runs on every request reads it back exactly as it
   * would from the original browser, permissions included. (2) would also work, but is strictly more
   * to build and run for the same outcome: a token endpoint, a one-time store for it, and an expiry
   * policy — machinery earned only if cookie forwarding turns out to be unsafe. It is not: the cookie
   * is set with an explicit `url` scoped to `127.0.0.1` on this process's own port, is never sent
   * anywhere else, and the browser that holds it is closed at the end of this one request.
   *
   * HOSTNAME: puppeteer always connects to `127.0.0.1:${port}` — never to `hostname` itself, which may
   * not even resolve from this process (a custom domain pointed at a load balancer in front of it, for
   * instance). What actually decides which site answers is this instance's own hostname→site mapping
   * (`WIKI.sitesMappings`, read off `req.hostname` on every request — see `index.ts`), so the caller's
   * own hostname is sent as a spoofed `Host` header via `page.setExtraHTTPHeaders` instead: reachable
   * over loopback like `models/renderQueue.ts`'s `/_render` shell, but resolving to the same site the
   * export was asked against.
   *
   * LOAD: one browser opened and closed per call at this model's own level — see the class comment.
   * `helpers/puppeteer.ts#launchPuppeteerBrowser` bounds how many of those (across this, `rendering.ts`
   * and `diagramRender.ts` combined) may be open across the whole process at once, and queues or
   * rejects (503) past that. If load testing ever shows exports themselves piling up waiting on that
   * shared ceiling, the fix is the same shape as `Rendering.drainQueue`: one browser reused across a
   * queue of waiting exports rather than one per request. Not built ahead of that need.
   */
  async exportPdf(request: PdfExportRequest): Promise<Buffer> {
    await this.ensureCanExport()

    const browser = await this.launchBrowser()
    try {
      const page = await browser.newPage()

      if (request.sessionCookie) {
        // -> Scoped to this process's own loopback origin — see the AUTH comment above. Marked
        //    `secure: true` even though puppeteer connects over plain `http://`: task 2109 made
        //    `SESSION_COOKIE_NAME` a `__Host-`-prefixed name, and Chromium's cookie store enforces
        //    that prefix's `Secure`-required rule at the store level (CDP's `Network.setCookie`
        //    included) regardless of how the cookie is being set, not just when parsing a
        //    `Set-Cookie` header — omitting it here would make the store reject the cookie outright,
        //    silently exporting the page as if anonymous. Safe to send over plain `http://` for the
        //    same reason `index.ts` can pin the browser-facing cookie `secure: true` unconditionally:
        //    `127.0.0.1` is a loopback address, which every major browser (Chromium included) treats
        //    as a potentially-trustworthy origin for `Secure` cookies regardless of scheme.
        await page.setCookie({
          name: sessionCookieName(),
          value: request.sessionCookie,
          url: `http://127.0.0.1:${request.port}`,
          httpOnly: true,
          secure: true
        })
      }

      // -> See the HOSTNAME comment above: this is what makes the loopback connection below resolve
      //    to the same site the export was asked against
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
   * Wait for `blockSettleScript` to finish, with the RENDER_TIMEOUT-style guard `Rendering.render`
   * uses for the same reason: `page.evaluate` has no timeout of its own, and what it runs here is
   * somebody else's async component code — a block stuck re-rendering itself would otherwise hold the
   * page, and this whole export, open indefinitely.
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

  /** Broken out so a test can mock it — see `pdfExport.test.ts` — the same way `import.ts` mocks `runPandoc`. */
  private async launchBrowser(): Promise<any> {
    return launchPuppeteerBrowser('exportPuppeteerMissing')
  }

  /**
   * Close a browser, and keep any trouble doing so to itself — the export either already has its PDF
   * or has already failed for its own reason, and neither should be replaced by a close failure.
   */
  private async discardBrowser(browser: any): Promise<void> {
    await closeQuietly(browser, 'export browser')
  }
}

export const pdfExport = new PdfExport()
