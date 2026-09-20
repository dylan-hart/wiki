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
import { getContentTypeForEditor } from './pages.ts'

const RENDER_READY_TIMEOUT = 30000

const RENDER_TIMEOUT = 30000

const DRAIN_TASK = 'renderPages'

interface PageRenderer {
  /**
   * `context` carries what the source cannot say about itself: the page's own path, which a
   * relative image resolves against; and the site's public origin, which `is-external-link` is
   * judged against — this browser sits on its own loopback address, not the site's hostname, so
   * without it every absolute same-site link comes back external here and internal in the editor.
   */
  render(
    content: string,
    config: Record<string, any>,
    context: Record<string, any>
  ): Promise<string>
  close(): Promise<void>
}

class RenderQueue {
  /** Puppeteer is an optional extension; only server-side rendering needs it. */
  async isAvailable(): Promise<boolean> {
    return isPuppeteerAvailable()
  }

  /**
   * Asked before anything is queued rather than left to the job: a request joining a queue nothing
   * will ever drain looks like it worked.
   *
   * Keyed off the editor's content type, not its name: the renderer bundle takes markdown in, so
   * any editor storing markdown can go through it — `wysiwyg` included. A literal
   * `editor !== 'markdown'` check would refuse those pages.
   */
  async ensureCanRender(editor: string): Promise<void> {
    if (getContentTypeForEditor(editor) !== 'markdown') {
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
   * One row per page, so repeated requests collapse into a single render of whatever the content
   * has become. `createdAt` is deliberately left alone on the conflict path: a repeat request is
   * not a new one and must not overtake pages that have been waiting longer.
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
    await CARDINAL.db
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

    const pending = await CARDINAL.db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.task, DRAIN_TASK))
      .limit(1)
    if (pending.length < 1) {
      // -> No retries: whatever stopped a render is still true on the next attempt, and the row
      //    stays queued for the next drain either way. A spare job finds the table empty and stops.
      await CARDINAL.scheduler.addJob({ task: DRAIN_TASK, maxRetries: 0 })
    }
  }

  /**
   * One browser for the whole batch — it costs hundreds of megabytes — and no two renders overlap.
   * The scheduler cannot promise that, since it runs up to `scheduler.workers` jobs at once, so a
   * concurrent call asks the running drain to look again rather than opening a second browser. That
   * also picks up a page queued between the last claim and the end of the drain.
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

  private draining = false

  private drainRequested = false

  /**
   * Claiming is a delete, so no two instances can pick up the same page. A failed render is not
   * re-queued — that would loop, since whatever made it fail is still true — and the page keeps the
   * HTML it had.
   *
   * A failure also drops the browser rather than trusting it: the likeliest one is a render that
   * ran out of time, leaving a tab wedged in whatever loop it was in, and the pages behind it in
   * the queue have done nothing to deserve that.
   */
  private async renderQueuedPages(): Promise<void> {
    // -> Cheap probe first, so the common drain — a spare job for a batch already swept — costs one
    //    query and launches nothing
    const waiting = await CARDINAL.db
      .select({ id: renderQueueTable.id })
      .from(renderQueueTable)
      .limit(1)
    if (waiting.length < 1) {
      return
    }
    if (!(await this.isAvailable())) {
      CARDINAL.logger.warn(
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
          not open is not this page's fault. Letting it throw ends the drain with the queue
          untouched, where treating it as a page failure would burn through every row — and claiming
          is a delete.
        */
        renderer ??= await this.createRenderer()

        const claimed = await CARDINAL.db
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
          const page = await CARDINAL.models.pages.getPage({
            siteId: entry.siteId,
            id: entry.pageId,
            withContent: true
          })
          if (!page) {
            // -> The cascade takes the queue row with a deleted page, so this is only reachable for
            //    one deleted between the claim and here
            continue
          }
          if (getContentTypeForEditor(page.editor) !== 'markdown') {
            CARDINAL.logger.warn(
              'render',
              'server-side rendering is not implemented for this editor',
              {
                page: page.id,
                editor: page.editor
              }
            )
            continue
          }
          const html = await renderer.render(
            page.content ?? '',
            {
              ...CARDINAL.sites[entry.siteId]?.config?.editors?.[page.editor]?.config,
              // -> No specific reader to speak for in a background re-render, so terms resolve as
              //    an anonymous visitor's would rather than skipping the permission check
              glossaryTerms: await CARDINAL.models.glossary.getCachedTerms(
                entry.siteId,
                CARDINAL.models.groups.guestActor()
              )
            },
            { pagePath: page.path, siteOrigin: this.resolveSiteOrigin(entry.siteId) }
          )
          await CARDINAL.models.pages.storeRender(
            entry.siteId,
            page.id,
            html,
            { scripts: entry.allowScripts, styles: entry.allowStyles },
            page.path
          )
          CARDINAL.logger.debug('render', 'rendered page from its source', {
            page: page.id,
            path: page.path
          })
        } catch (err: any) {
          CARDINAL.logger.warn('render', 'rendering the page failed', {
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
   * Swallows close failures: every close happens on a path already finished with the browser, most
   * right after a render failed, so letting one out would replace the real error or fail a drain
   * that had otherwise finished its work.
   */
  private async discardRenderer(renderer: PageRenderer | null): Promise<void> {
    await closeQuietly(renderer, 'render browser')
  }

  /**
   * `https://<hostname>` is assumed, as `models/mail.ts` does: no per-site scheme/port override
   * exists. `undefined` for the `*` catch-all site (no hostname of its own) or an unresolvable id,
   * leaving the renderer to classify links against the headless browser's own loopback `location`.
   */
  private resolveSiteOrigin(siteId: string): string | undefined {
    const hostname = CARDINAL.sites[siteId]?.hostname
    return hostname && hostname !== '*' ? `https://${hostname}` : undefined
  }

  /**
   * The markdown pipeline lives in the frontend and stays there — this drives it rather than
   * reimplementing it, so a page rendered by the server comes out identical to one saved from the
   * editor.
   *
   * One tab serves any number of pages: `__wikiRender` builds a fresh renderer per call and returns
   * a string, so nothing carries over between them but the bundle's own warm caches.
   */
  private async createRenderer(): Promise<PageRenderer> {
    const browser = await launchPuppeteerBrowser('renderPuppeteerMissing')
    try {
      const page = await browser.newPage()
      // -> Loopback, so the bundle loaded is the one this instance's own editor uses
      await page.goto(`http://127.0.0.1:${CARDINAL.config.port}/_render`, {
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
            content somebody else wrote: an input that sends a markdown plugin into catastrophic
            backtracking would hold the browser for as long as it runs, and every page behind it in
            the queue with it. Losing the race throws, and the caller closes this renderer rather
            than reusing a tab that is still busy.
          */
          // -> The callback is serialized and runs in the browser, where `globalThis` is the window
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
      // -> Whatever went wrong loading the bundle is the failure worth reporting, not whatever
      //    closing the now-unusable browser says about it
      try {
        await browser.close()
      } catch {}
      throw err
    }
  }
}

export const renderQueue = new RenderQueue()
