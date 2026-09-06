import { deflateRawSync } from 'node:zlib'
import { CustomError } from '../helpers/common.ts'
import {
  assertPuppeteerAvailable,
  closeQuietly,
  isPuppeteerAvailable,
  launchPuppeteerBrowser
} from '../helpers/puppeteer.ts'
import { withTimeout } from '../helpers/timeout.ts'
import { blockSettleScript } from './pdfExport.ts'

/** How long a Mermaid render's page setup gets before giving up, in milliseconds. */
const RENDER_SETUP_TIMEOUT = 15000

/**
 * How many rounds `blockSettleScript` polls Lit's `updateComplete` before giving up — see the
 * identical constant on `pdfExport.ts`. This mounts exactly one block rather than a whole page, so it
 * needs no separate coarser timeout of its own; `RENDER_SETTLE_TIMEOUT` below is that guard.
 */
const RENDER_SETTLE_MAX_ROUNDS = 20

/** How long the settle wait gets once the block is mounted, in milliseconds. */
const RENDER_SETTLE_TIMEOUT = 15000

/** Mermaid themes `block-diagram` actually draws with — `auto` is the block's own reader-following
 *  choice and means nothing without a reader to follow, so a caller here gets `default` instead. */
const MERMAID_THEMES = ['default', 'dark', 'neutral', 'forest']

/** A source past this length is refused before a browser is ever opened — see `renderMermaid`. */
const MAX_MERMAID_SOURCE_LENGTH = 20000

/** The PlantUML server a site draws against unless its `block-plantuml` config names one of its own. */
const DEFAULT_PLANTUML_SERVER = 'https://www.plantuml.com/plantuml'

/**
 * How long the PlantUML fetch gets before it is treated as unreachable — the same guard, and the
 * same value, `models/liveData.ts#FETCH_TIMEOUT_MS` uses for exactly the same reason: an outbound
 * request this instance did not choose the destination for (today, the fixed default server; once
 * OpenProject #2223 lands, a site-configured one) must not be able to tie up a `limitRenders` slot
 * indefinitely.
 */
const PLANTUML_FETCH_TIMEOUT_MS = 10000

/**
 * PlantUML's own alphabet for the text it carries in a URL — mirrored from
 * `blocks/block-plantuml/component.js`'s `ALPHABET`. Base64 by shape but not by order, so the
 * standard encoders cannot be used.
 */
const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

/**
 * The same ceiling `blocks/shared/url-limit.js#MAX_DIAGRAM_URL_LENGTH` enforces client-side, mirrored
 * here so a diagram too large to draw fails with an explanation instead of a confusing upstream error
 * from whatever sits in front of the PlantUML server.
 */
const MAX_PLANTUML_URL_LENGTH = 8000

export type DiagramType = 'mermaid' | 'plantuml'
export type DiagramFormat = 'svg' | 'png'

export interface DiagramRenderRequest {
  type: DiagramType
  /** The diagram's fenced source, exactly as an author would write it inside ```mermaid/```plantuml. */
  source: string
  /** Mermaid only. One of `MERMAID_THEMES`; anything else (including `auto`) falls back to `default`. */
  theme?: string
  format?: DiagramFormat
}

export interface DiagramRenderResult {
  contentType: string
  data: Buffer
}

/**
 * Runs inside the headless browser via `page.evaluate(importBlockScript, scriptUrl)`.
 *
 * Loads the block's own compiled bundle — the exact code a reader's browser runs, served from this
 * instance the same way `/_blocks/<tag>.js` always is — which is what defines the custom element
 * `mountBlockElementScript` below then creates. Kept as its own step, rather than folded into that one,
 * because a dynamic `import()` of a network specifier is meaningless outside a real browser page: there
 * is nothing to unit-test here that stubbing `globalThis` could stand in for, the same way this
 * module's tests never exercise a real `page.goto` either — see `diagramRender.test.ts`.
 */
export async function importBlockScript(scriptUrl: string): Promise<void> {
  await import(scriptUrl)
}

/**
 * Runs inside the headless browser via `page.evaluate(mountBlockElementScript, tag, attrs, source)`,
 * once `importBlockScript` has defined the custom element.
 *
 * Mounts one instance of the block on an otherwise empty page, with `source` as its fenced body. That
 * is exactly how `block-diagram`'s `firstUpdated()` reads its source back:
 * `this.querySelector('pre').textContent`, so a `<pre>` child is what this writes rather than the
 * element's own `textContent`, matching how markdown itself hands the block its fence and keeping this
 * indistinguishable from a real page to the component's own code.
 *
 * A plain, named, parameterized function rather than a closure, for the same reason
 * `pdfExport.ts#blockSettleScript` is one: Puppeteer serializes this to a string and re-evaluates it in
 * the page's own realm, so nothing here may close over this module, and every DOM global is read off
 * `globalThis` since the backend's `tsconfig.json` has no `dom` lib.
 */
export function mountBlockElementScript(
  tag: string,
  attrs: Record<string, string>,
  source: string
): void {
  const doc = (globalThis as any).document
  const el = doc.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value)
  }
  const pre = doc.createElement('pre')
  pre.textContent = source
  el.appendChild(pre)
  doc.body.appendChild(el)
}

/**
 * Runs inside the headless browser via `page.evaluate(extractDiagramScript, tag)`, once
 * `blockSettleScript` says the block mounted by `mountBlockElementScript` has settled.
 *
 * Reads back exactly what a reader would see: the SVG the block drew, through its shadow root since
 * every block is a `LitElement` and renders into one — or, when it could not be drawn, the text of its
 * own `.error` panel, so a caller here fails with the same message a reader would rather than a generic
 * one this module invents on its behalf.
 */
export async function extractDiagramScript(
  tag: string
): Promise<{ svg: string | null; error: string | null }> {
  const doc = (globalThis as any).document
  const el = doc.querySelector(tag)
  const shadow = el?.shadowRoot
  const errorEl = shadow?.querySelector('.error')
  if (errorEl) {
    return { svg: null, error: errorEl.textContent ?? 'This diagram could not be drawn.' }
  }
  const svg = shadow?.querySelector('svg')
  if (!svg) {
    return { svg: null, error: 'This diagram produced no drawing.' }
  }
  return { svg: svg.outerHTML, error: null }
}

/**
 * Diagram pre-render model
 *
 * Server-side rendering of a single Mermaid or PlantUML diagram to a static SVG or PNG, for a context
 * that cannot or should not run the block's own client-side JS to draw one itself — a faster PDF
 * export that pre-renders a page's diagrams instead of waiting on the live page view to draw them one
 * at a time, or serving a diagram to a client that never loads the block runtime at all. Deferred from
 * Feature 402 as OpenProject task 785 — see `docs/decisions/diagram-prerendering-scope.md` for why,
 * and the design this settles on.
 *
 * MERMAID drives Puppeteer, sharing `helpers/puppeteer.ts` with `models/pdfExport.ts` and
 * `models/renderQueue.ts` for the browser itself: `block-diagram` draws with the `mermaid` library,
 * which needs a real DOM to lay out and paint into, so there is no way to produce its SVG without one.
 * Rather than reimplementing that pipeline against a bare `mermaid` import (a second copy of the
 * dependency, liable to drift from what `block-diagram` actually ships), this mounts the block's own
 * compiled bundle — the same one `/_blocks/block-diagram.js` serves to every reader — on a page of its
 * own and waits for it with the same `blockSettleScript` `pdfExport.ts` rides for a whole page,
 * because it is exactly the same wait: whether one block or many, "has every block's `updateComplete`
 * gone false" is the same question with the same answer.
 *
 * PLANTUML needs none of that. `block-plantuml` never draws locally — it deflates the source into a
 * PlantUML server's GET URL and lets the reader's browser fetch an `<img>` from it, so the "diagram
 * rendering JS" a client skips by asking this model instead is not a browser-side rendering *engine*
 * at all, only the deflate-and-request the block would otherwise do on its own. This mirrors that
 * transport with Node's built-in `zlib.deflateRawSync` (raw DEFLATE, byte-for-byte what `pako`'s
 * `deflateRaw` produces) and fetches the bytes directly rather than opening a browser to load an
 * `<img>` — the Puppeteer extension is therefore never required for a PlantUML request.
 */
class DiagramRender {
  /** Whether this instance can render a Mermaid diagram — PlantUML needs no browser, so it asks nothing here. */
  async isAvailable(): Promise<boolean> {
    return isPuppeteerAvailable()
  }

  /** Refuse a Mermaid request when this instance cannot draw one. PlantUML never reaches this. */
  private async ensureCanRenderMermaid(): Promise<void> {
    await assertPuppeteerAvailable(
      'diagramRenderPuppeteerMissing',
      'Rendering a Mermaid diagram on the server needs the Puppeteer extension, which is not installed.'
    )
  }

  /**
   * Render one diagram to a static image, dispatching on `request.type`.
   *
   * @param siteId The site to render against — only PlantUML reads it, to look up that site's
   * `block-plantuml` config (`resolvePlantumlServer()`), since which server it renders against is
   * admin-configured per site rather than caller-supplied (OpenProject task 2223). Left undefined
   * falls back to the public default the same as a site with nothing configured.
   */
  async render(request: DiagramRenderRequest, siteId?: string): Promise<DiagramRenderResult> {
    const format: DiagramFormat = request.format === 'png' ? 'png' : 'svg'
    if (!request.source?.trim()) {
      throw new CustomError('diagramRenderEmpty', 'There is no diagram source to render.', 400)
    }
    if (request.type === 'plantuml') {
      return this.renderPlantuml(request.source, siteId, format)
    }
    if (request.type === 'mermaid') {
      return this.renderMermaid(request.source, request.theme, format)
    }
    throw new CustomError(
      'diagramRenderUnsupportedType',
      `Unsupported diagram type: ${request.type}`,
      400
    )
  }

  /**
   * Draw a Mermaid diagram by mounting `block-diagram` itself on a blank Puppeteer page. See the class
   * comment for why this is the whole block rather than a bare `mermaid` import.
   */
  private async renderMermaid(
    source: string,
    theme: string | undefined,
    format: DiagramFormat
  ): Promise<DiagramRenderResult> {
    await this.ensureCanRenderMermaid()
    if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
      throw new CustomError(
        'diagramRenderTooLarge',
        `This diagram's source is ${source.length.toLocaleString()} characters, over the ${MAX_MERMAID_SOURCE_LENGTH.toLocaleString()}-character limit rendering it on the server allows.`,
        413
      )
    }
    const resolvedTheme = MERMAID_THEMES.includes(theme ?? '') ? theme! : 'default'

    const browser = await this.launchBrowser()
    try {
      const page = await browser.newPage()
      // -> `page.setContent`/`page.evaluate` have no timeout of their own, and what runs past them is
      //    somebody else's code — so each step of the Mermaid path is raced against one, the same
      //    `504` guard every headless-browser path in this codebase uses
      await withTimeout(
        page.setContent('<!doctype html><html><body></body></html>'),
        RENDER_SETUP_TIMEOUT,
        () =>
          new CustomError(
            'diagramRenderSetupTimeout',
            `The render page did not come up within ${RENDER_SETUP_TIMEOUT / 1000} seconds.`,
            504
          )
      )
      await withTimeout(
        page.evaluate(
          importBlockScript,
          `http://127.0.0.1:${WIKI.config.port}/_blocks/block-diagram.js`
        ),
        RENDER_SETUP_TIMEOUT,
        () =>
          new CustomError(
            'diagramRenderSetupTimeout',
            `The diagram block did not load within ${RENDER_SETUP_TIMEOUT / 1000} seconds.`,
            504
          )
      )
      await page.evaluate(
        mountBlockElementScript,
        'block-diagram',
        { theme: resolvedTheme },
        source
      )
      await withTimeout(
        page.evaluate(blockSettleScript, RENDER_SETTLE_MAX_ROUNDS),
        RENDER_SETTLE_TIMEOUT,
        () =>
          new CustomError(
            'diagramRenderSettleTimeout',
            `The diagram did not finish drawing within ${RENDER_SETTLE_TIMEOUT / 1000} seconds.`,
            504
          )
      )

      const { svg, error } = await page.evaluate(extractDiagramScript, 'block-diagram')
      if (error || !svg) {
        throw new CustomError(
          'diagramRenderFailed',
          error ?? 'This diagram could not be drawn.',
          422
        )
      }

      if (format === 'png') {
        const handle = await page.$('block-diagram')
        const png = await handle.screenshot({ omitBackground: true })
        return { contentType: 'image/png', data: Buffer.from(png) }
      }
      return { contentType: 'image/svg+xml', data: Buffer.from(svg, 'utf8') }
    } finally {
      await this.discardBrowser(browser)
    }
  }

  /**
   * Fetch a PlantUML diagram's bytes directly from the server that would otherwise have drawn it into
   * a reader's `<img>` — see the class comment for why no browser is involved.
   */
  private async renderPlantuml(
    source: string,
    siteId: string | undefined,
    format: DiagramFormat
  ): Promise<DiagramRenderResult> {
    if (WIKI.config.offline) {
      throw new CustomError(
        'diagramRenderOffline',
        'Cardinal.js is in offline mode and cannot reach a PlantUML server to render this diagram.',
        503
      )
    }

    const server = await this.resolvePlantumlServer(siteId)
    const url = this.plantumlUrl(source, server, format)
    if (url.length > MAX_PLANTUML_URL_LENGTH) {
      throw new CustomError(
        'diagramRenderTooLarge',
        `This diagram is too large to draw: its encoded source is ${url.length.toLocaleString()} characters, over the ${MAX_PLANTUML_URL_LENGTH.toLocaleString()}-character limit a GET request to the PlantUML server allows. Simplify the diagram, or draw it with Mermaid instead.`,
        413
      )
    }

    let response: Response
    try {
      // -> `redirect: 'error'` and a bounded timeout, the same hardening
      //    `models/liveData.ts#resolve` applies to its own caller-influenced fetch — a redirecting
      //    or hanging PlantUML server must not be able to bounce this request elsewhere, or hold a
      //    `limitRenders` slot open indefinitely. See `LiveData#resolve`'s comment for the full
      //    reasoning; it applies here unchanged.
      response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(PLANTUML_FETCH_TIMEOUT_MS)
      })
    } catch (err: any) {
      throw new CustomError(
        'diagramRenderFailed',
        `The PlantUML server could not be reached: ${err.message}`,
        502
      )
    }
    // -> Best-effort, the same as `block-plantuml`'s own `_explain()`: a server behind a proxy that
    //    strips this header still answers, just without the specific reason
    const reason = response.headers.get('x-plantuml-diagram-error')
    if (reason) {
      throw new CustomError(
        'diagramRenderFailed',
        `PlantUML could not read this diagram: ${reason}`,
        422
      )
    }
    if (!response.ok) {
      throw new CustomError(
        'diagramRenderFailed',
        `The PlantUML server answered ${response.status} ${response.statusText} for this diagram.`,
        502
      )
    }
    const data = Buffer.from(await response.arrayBuffer())
    return { contentType: format === 'png' ? 'image/png' : 'image/svg+xml', data }
  }

  /**
   * The PlantUML server this site is configured to render against — its `block-plantuml` row's
   * site-level `server` config value (`models/blocks.ts`'s `assertValidConfig` validates it at write
   * time, so it is trusted as-is here), or `DEFAULT_PLANTUML_SERVER` when the site has none, has no
   * such block row at all, or `siteId` itself is unknown (never happens for a real request — the route
   * always resolves one via the request's hostname — but is not worth a throw here either).
   */
  private async resolvePlantumlServer(siteId: string | undefined): Promise<string> {
    if (!siteId) {
      return DEFAULT_PLANTUML_SERVER
    }
    const siteBlocks = await WIKI.models.blocks.getSiteBlocks(siteId)
    const plantuml = siteBlocks.find((block) => block.block === 'plantuml')
    const configured =
      typeof plantuml?.config?.server === 'string' ? plantuml.config.server.trim() : ''
    return configured || DEFAULT_PLANTUML_SERVER
  }

  /** The URL `block-plantuml` itself would set as an `<img src>` for this source. */
  private plantumlUrl(source: string, server: string, format: DiagramFormat): string {
    const base = server.replace(/\/+$/, '')
    return `${base}/${format}/${this.encodeForUrl(source)}`
  }

  /** A diagram source as it goes into a PlantUML URL — see `PLANTUML_ALPHABET`'s comment. */
  private encodeForUrl(source: string): string {
    const bytes = deflateRawSync(Buffer.from(source, 'utf8'), { level: 9 })
    let encoded = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const b1 = bytes[i]
      const b2 = bytes[i + 1] ?? 0
      const b3 = bytes[i + 2] ?? 0
      encoded += PLANTUML_ALPHABET[b1 >> 2]
      encoded += PLANTUML_ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)]
      encoded += PLANTUML_ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)]
      encoded += PLANTUML_ALPHABET[b3 & 0x3f]
    }
    return encoded
  }

  /** Broken out so a test can mock it — the same shape `pdfExport.ts#launchBrowser` uses. */
  private async launchBrowser(): Promise<any> {
    return launchPuppeteerBrowser('diagramRenderPuppeteerMissing')
  }

  /** Close a browser, and keep any trouble doing so to itself — see `pdfExport.ts#discardBrowser`. */
  private async discardBrowser(browser: any): Promise<void> {
    await closeQuietly(browser, 'diagram render browser')
  }
}

export const diagramRender = new DiagramRender()
