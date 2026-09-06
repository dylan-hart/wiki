import { eq, inArray, sql } from 'drizzle-orm'
import { jobs as jobsTable, pageRenderQueue as renderQueueTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import {
  assertPuppeteerAvailable,
  closeQuietly,
  isPuppeteerAvailable,
  launchPuppeteerBrowser
} from '../helpers/puppeteer.ts'
import { withTimeout } from '../helpers/timeout.ts'
import type { RenderPermissions } from '../helpers/htmlSanitizePolicy.ts'

/**
 * Render queue model
 *
 * Re-rendering an existing page from its source — which the server needs when the content is there
 * but the render is stale — goes back through the very same frontend pipeline `models/rendering.ts`
 * describes, driven in a headless browser. That is a job rather than part of a request, and this is
 * that job: `queuePage` records the request, `drainQueue` claims the rows one at a time and renders
 * them through a single browser, and `isAvailable`/`ensureCanRender` answer whether this instance can
 * do any of it at all.
 */

/** How long the renderer bundle gets to load itself in the headless browser, in milliseconds. */
const RENDER_READY_TIMEOUT = 30000

/** How long a single render gets once the bundle is up, in milliseconds. */
const RENDER_TIMEOUT = 30000

/** The task that drains the render queue. One browser, one page at a time. */
const DRAIN_TASK = 'renderPages'

/**
 * A headless browser standing by on the renderer bundle, good for any number of pages.
 *
 * Opening one is the expensive part of rendering, so it is handed out as a handle to be reused and
 * closed by whoever asked for it rather than opened per page.
 */
interface PageRenderer {
  /**
   * Markdown in, the editor's own HTML out — before `postProcess` gets to it.
   *
   * `context` carries what the source cannot say about itself: the page's own path, which a relative
   * image resolves against the folder it sits in, as it would in a repository; and the site's own
   * public origin, which `is-external-link` classification is judged against (OpenProject #1751) —
   * this browser is navigated to its own loopback address, not the site's hostname, so without it
   * every absolute same-site link would come back external here and internal in the editor that saved
   * it.
   */
  render(
    content: string,
    config: Record<string, any>,
    context: Record<string, any>
  ): Promise<string>
  close(): Promise<void>
}

class RenderQueue {
  /**
   * Whether this instance can render a page at all.
   *
   * Puppeteer is an extension, and one that is not installed by default: rendering server-side is the
   * only thing that needs it, and everything else keeps working without it.
   */
  async isAvailable(): Promise<boolean> {
    return isPuppeteerAvailable()
  }

  /**
   * Refuse the caller when a page like this one cannot be rendered here.
   *
   * Asked before anything is queued or written rather than left to the job: a request that joins a
   * queue nothing will ever drain looks like it worked, and an approval that cannot produce a matching
   * render would leave a page's HTML lying about its content.
   */
  async ensureCanRender(editor: string): Promise<void> {
    if (editor !== 'markdown') {
      throw new CustomError(
        'renderUnsupportedEditor',
        `Server-side rendering is not implemented for the ${editor} editor.`
      )
    }
    await assertPuppeteerAvailable(
      'renderPuppeteerMissing',
      'Rendering a page on the server needs the Puppeteer extension, which is not installed.'
    )
  }

  /**
   * Ask for a page to be rendered, and make sure something will come along to do it.
   *
   * The row is the request and there is only ever one per page, so asking repeatedly — a queue of
   * suggestions being approved onto the same page, an impatient author — collapses into one render of
   * whatever the content has become. `createdAt` is left alone on that path, since a repeat request is
   * not a new one and must not overtake pages that have been waiting longer.
   *
   * The drain job is only added when the queue has none pending, and a spare one is harmless anyway:
   * it finds the table empty and returns without so much as launching a browser.
   */
  async queuePage({
    siteId,
    pageId,
    permissions,
    requestedById
  }: {
    siteId: string
    pageId: string
    permissions: RenderPermissions
    requestedById?: string | null
  }): Promise<void> {
    await WIKI.db
      .insert(renderQueueTable)
      .values({
        siteId,
        pageId,
        allowScripts: permissions.scripts,
        allowStyles: permissions.styles,
        requestedById: requestedById ?? null
      })
      .onConflictDoUpdate({
        target: renderQueueTable.pageId,
        set: {
          allowScripts: permissions.scripts,
          allowStyles: permissions.styles,
          requestedById: requestedById ?? null,
          updatedAt: sql`now()`
        }
      })

    const pending = await WIKI.db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.task, DRAIN_TASK))
      .limit(1)
    if (pending.length < 1) {
      // -> No retries: a render nobody can produce is not worth attempting three times, and the row
      //    stays queued for the next drain either way
      await WIKI.scheduler.addJob({ task: DRAIN_TASK, maxRetries: 0 })
    }
  }

  /**
   * Render every queued page, one at a time, through a single browser.
   *
   * This is the whole point of the queue: a browser costs hundreds of megabytes, so there is exactly
   * one, it is opened when the first page is claimed and reused for the rest of the batch, and no two
   * renders overlap. The scheduler cannot promise that on its own — it runs up to
   * `scheduler.workers` jobs at once — so a second call while this is running does not start a second
   * browser. It asks the one already going to look again before it stops, which is what stops a page
   * queued in the moment between the last claim and the end of the drain from waiting for the next
   * request to come along.
   */
  async drainQueue(): Promise<void> {
    if (this.draining) {
      this.drainRequested = true
      return
    }
    this.draining = true
    try {
      do {
        this.drainRequested = false
        await this.renderQueuedPages()
      } while (this.drainRequested)
    } finally {
      this.draining = false
    }
  }

  /** True while `drainQueue` is working, so that a second call joins it instead of duplicating it. */
  private draining = false

  /** Set when a drain is asked for during one, and re-checked before the running drain gives up. */
  private drainRequested = false

  /**
   * The drain itself: claim a page, render it, store it, repeat until the queue is empty.
   *
   * Claiming is a delete, so an instance can never pick up a page another one is already rendering,
   * and a render that fails is a render that was asked for and did not happen — logged, with the page
   * keeping the HTML it had. Re-queueing it here would be a loop, since whatever made it fail is still
   * true.
   *
   * A failure also drops the browser rather than trusting it: the likeliest one is a render that ran
   * out of time, which leaves a page wedged in whatever loop it was in, and the pages behind it in the
   * queue have done nothing to deserve that.
   */
  private async renderQueuedPages(): Promise<void> {
    // -> Asked before anything else so that the common drain — a spare job for a batch already swept —
    //    costs one query and says nothing
    const waiting = await WIKI.db
      .select({ id: renderQueueTable.id })
      .from(renderQueueTable)
      .limit(1)
    if (waiting.length < 1) {
      return
    }
    if (!(await this.isAvailable())) {
      WIKI.logger.warn(
        'render',
        'pages are queued for rendering but the Puppeteer extension is not installed, leaving them queued'
      )
      return
    }

    let renderer: PageRenderer | null = null
    try {
      while (true) {
        /*
          Deliberately outside the per-page catch below, and ahead of the claim: a browser that will
          not open is not this page's fault and will not be the next one's either. Letting that throw
          ends the drain with the queue untouched, where treating it as a page failure would burn
          through every row in it — and claiming is a delete.
        */
        renderer ??= await this.createRenderer()

        const claimed = await WIKI.db
          .delete(renderQueueTable)
          .where(
            inArray(
              renderQueueTable.id,
              sql`(SELECT id FROM "pageRenderQueue" ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)`
            )
          )
          .returning()
        const entry = claimed[0]
        if (!entry) {
          return
        }

        try {
          const page = await WIKI.models.pages.getPage({
            siteId: entry.siteId,
            id: entry.pageId,
            withContent: true
          })
          if (!page) {
            // -> Deleted while it waited. The cascade takes the row with it, so this is only reachable
            //    for a page that went between the claim and here.
            continue
          }
          if (page.editor !== 'markdown') {
            WIKI.logger.warn('render', 'server-side rendering is not implemented for this editor', {
              page: page.id,
              editor: page.editor
            })
            continue
          }
          const html = await renderer.render(
            page.content ?? '',
            {
              ...WIKI.sites[entry.siteId]?.config?.editors?.[page.editor]?.config,
              // -> No specific reader to speak for in a background re-render (OpenProject #1127) --
              //    resolved as an anonymous visitor would be, rather than skipping the check.
              glossaryTerms: await WIKI.models.glossary.getCachedTerms(
                entry.siteId,
                WIKI.models.groups.guestActor()
              )
            },
            { pagePath: page.path, siteOrigin: this.resolveSiteOrigin(entry.siteId) }
          )
          await WIKI.models.pages.storeRender(
            entry.siteId,
            page.id,
            html,
            { scripts: entry.allowScripts, styles: entry.allowStyles },
            page.path
          )
          WIKI.logger.debug('render', 'rendered page from its source', {
            page: page.id,
            path: page.path
          })
        } catch (err: any) {
          WIKI.logger.warn('render', 'rendering the page failed', {
            page: entry.pageId,
            error: err
          })
          await this.discardRenderer(renderer)
          renderer = null
        }
      }
    } finally {
      await this.discardRenderer(renderer)
    }
  }

  /**
   * Close a renderer, and keep any trouble doing so to itself.
   *
   * Every close happens on a path that is already finished with the browser — most of them right after
   * a render failed, which is exactly when it is likeliest to be gone already. Letting that failure
   * out would replace the real one, or fail a drain that had otherwise finished its work.
   */
  private async discardRenderer(renderer: PageRenderer | null): Promise<void> {
    await closeQuietly(renderer, 'render browser')
  }

  /**
   * The site's real public origin, for the headless renderer's `is-external-link` classification to
   * match what the same page's own editor save would have produced (OpenProject #1751).
   *
   * `https://<hostname>` is assumed, matching `models/mail.ts`'s `resolveMailBaseURL` — no per-site
   * override setting exists for scheme/port (v1 scope decision, OpenProject #1023). `undefined` for
   * the `*` catch-all site (no hostname of its own) or an unresolvable siteId: `isExternalHref` then
   * falls back to the headless browser's own `location`, exactly the pre-#1751 behavior, since there
   * is no real origin to compare against.
   */
  private resolveSiteOrigin(siteId: string): string | undefined {
    const hostname = WIKI.sites[siteId]?.hostname
    return hostname && hostname !== '*' ? `https://${hostname}` : undefined
  }

  /**
   * Open a headless browser on the renderer bundle and hand back something that renders through it.
   *
   * The markdown pipeline lives in the frontend and stays there — this drives it rather than
   * reimplementing it, so a page rendered by the server comes out identical to one saved from the
   * editor.
   *
   * One tab is enough for any number of pages: `__wikiRender` builds a fresh renderer per call and
   * returns a string, so nothing carries over between them but the bundle's own warm caches.
   */
  private async createRenderer(): Promise<PageRenderer> {
    // -> `helpers/puppeteer.ts` also backs `models/pdfExport.ts`'s PDF export, so both share one
    //    launch path — same flags, same load-failure tracking
    const browser = await launchPuppeteerBrowser('renderPuppeteerMissing')
    try {
      const page = await browser.newPage()
      // -> A shell page whose only job is to load the frontend's renderer bundle. It is served by this
      //    instance, so the bundle it loads is the one this instance's editor uses.
      await page.goto(`http://127.0.0.1:${WIKI.config.port}/_render`, {
        waitUntil: 'networkidle0'
      })
      await page.waitForFunction('window.__wikiRenderReady === true', {
        timeout: RENDER_READY_TIMEOUT
      })

      return {
        async render(
          content: string,
          config: Record<string, any>,
          context: Record<string, any>
        ): Promise<string> {
          /*
            `page.evaluate` has no timeout of its own, and what it calls is a synchronous pass over
            content somebody else wrote: an input that sends one of the markdown plugins into
            catastrophic backtracking would otherwise hold the browser open for as long as it runs, and
            every page behind it in the queue with it. Losing the race throws, and the caller closes
            this renderer rather than reusing a tab that is still busy.
          */
          // -> This callback is serialized and runs in the browser, where `globalThis` is the window
          //    the renderer bundle attached itself to
          return await withTimeout(
            page.evaluate(
              (src: string, cfg: Record<string, any>, ctx: Record<string, any>) =>
                (globalThis as any).__wikiRender(src, cfg, ctx),
              content,
              config,
              context
            ),
            RENDER_TIMEOUT,
            () =>
              new CustomError(
                'renderTimeout',
                `Rendering did not finish within ${RENDER_TIMEOUT / 1000} seconds.`,
                504
              )
          )
        },
        async close(): Promise<void> {
          await browser.close()
        }
      }
    } catch (err: any) {
      // -> The browser is up but unusable, and nothing else holds a reference to it. Whatever went
      //    wrong loading the bundle is the failure worth reporting, not whatever closing says about it.
      try {
        await browser.close()
      } catch {}
      throw err
    }
  }
}

export const renderQueue = new RenderQueue()
