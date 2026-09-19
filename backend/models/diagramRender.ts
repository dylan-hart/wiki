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

const RENDER_SETUP_TIMEOUT = 15000

/** Rounds `blockSettleScript` spends polling Lit's `updateComplete` before giving up. */
const RENDER_SETTLE_MAX_ROUNDS = 20

const RENDER_SETTLE_TIMEOUT = 15000

/** Themes `block-diagram` actually draws with — `auto` is its reader-following choice and means
 *  nothing without a reader to follow, so a caller here gets `default` instead. */
const MERMAID_THEMES = ['default', 'dark', 'neutral', 'forest']

const MAX_MERMAID_SOURCE_LENGTH = 20000

const DEFAULT_PLANTUML_SERVER = 'https://www.plantuml.com/plantuml'

/**
 * An outbound request whose destination this instance did not choose must not be able to tie up a
 * `limitRenders` slot indefinitely.
 */
const PLANTUML_FETCH_TIMEOUT_MS = 10000

/**
 * PlantUML's own alphabet for the text it carries in a URL: base64 by shape but not by order, so the
 * standard encoders cannot be used.
 */
const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

/**
 * The ceiling a GET to the PlantUML server allows. Enforced here so a diagram too large to draw
 * fails with an explanation instead of a confusing error from whatever sits in front of that server.
 */
const MAX_PLANTUML_URL_LENGTH = 8000

export type DiagramType = 'mermaid' | 'plantuml'
export type DiagramFormat = 'svg' | 'png'

export interface DiagramRenderRequest {
  type: DiagramType
  /** The fenced body, exactly as an author writes it inside ```mermaid/```plantuml. */
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
 * Runs inside the headless browser via `page.evaluate`. Loads the block's own compiled bundle — the
 * exact code a reader's browser runs — which is what defines the custom element
 * `mountBlockElementScript` then creates.
 */
export async function importBlockScript(scriptUrl: string): Promise<void> {
  await import(scriptUrl)
}

/**
 * Runs inside the headless browser via `page.evaluate`, once `importBlockScript` has defined the
 * custom element.
 *
 * `block-diagram`'s `firstUpdated()` reads its source back as `this.querySelector('pre').textContent`,
 * so the source goes into a `<pre>` child rather than the element's own `textContent`.
 *
 * Puppeteer serializes this to a string and re-evaluates it in the page's own realm, so nothing here
 * may close over this module, and every DOM global is read off `globalThis` since the backend's
 * `tsconfig.json` has no `dom` lib.
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
 * Runs inside the headless browser via `page.evaluate`, once `blockSettleScript` says the mounted
 * block has settled.
 *
 * Reads through the shadow root, since every block is a `LitElement` and renders into one, and falls
 * back to the block's own `.error` panel text so a caller fails with the message a reader would have
 * seen rather than a generic one this module invents.
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
 * Server-side rendering of a single Mermaid or PlantUML diagram to a static SVG or PNG, for a
 * context that cannot or should not run the block's own client-side JS to draw one itself.
 *
 * MERMAID drives Puppeteer: `block-diagram` draws with the `mermaid` library, which needs a real DOM
 * to lay out and paint into. Rather than reimplementing that pipeline against a bare `mermaid`
 * import — a second copy of the dependency, liable to drift from what `block-diagram` ships — this
 * mounts the block's own compiled bundle on a page of its own and waits for it with the same
 * `blockSettleScript` `pdfExport.ts` rides for a whole page.
 *
 * PLANTUML needs none of that: `block-plantuml` never draws locally, it deflates the source into a
 * PlantUML server's GET URL and lets the reader's browser fetch an `<img>`. This mirrors that
 * transport with Node's built-in `zlib.deflateRawSync` (raw DEFLATE, byte-for-byte what `pako`'s
 * `deflateRaw` produces) and fetches the bytes directly, so the Puppeteer extension is never
 * required for a PlantUML request.
 */
class DiagramRender {
  /** Mermaid only — PlantUML needs no browser, so it asks nothing here. */
  async isAvailable(): Promise<boolean> {
    return isPuppeteerAvailable()
  }

  private async ensureCanRenderMermaid(): Promise<void> {
    await assertPuppeteerAvailable(
      'diagramRenderPuppeteerMissing',
      'Rendering a Mermaid diagram on the server needs the Puppeteer extension, which is not installed.'
    )
  }

  /**
   * @param siteId Only PlantUML reads it, to look up that site's admin-configured `block-plantuml`
   * server. Left undefined falls back to the public default, the same as a site with none.
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
      // -> `page.setContent`/`page.evaluate` have no timeout of their own, and what runs past them
      //    is somebody else's code, so each step is raced against one
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
          `http://127.0.0.1:${CARDINAL.config.port}/_blocks/block-diagram.js`
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

  private async renderPlantuml(
    source: string,
    siteId: string | undefined,
    format: DiagramFormat
  ): Promise<DiagramRenderResult> {
    if (CARDINAL.config.offline) {
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
      // -> `redirect: 'error'` and a bounded timeout: a redirecting or hanging PlantUML server must
      //    not be able to bounce this request elsewhere, or hold a `limitRenders` slot open
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
    // -> Best-effort: a server behind a proxy that strips this header still answers, just without
    //    the specific reason
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
   * The site's `block-plantuml` `server` config value, or `DEFAULT_PLANTUML_SERVER` when it has
   * none. `models/blocks.ts`'s `assertValidConfig` validates the value at write time, so it is
   * trusted as-is here.
   */
  private async resolvePlantumlServer(siteId: string | undefined): Promise<string> {
    if (!siteId) {
      return DEFAULT_PLANTUML_SERVER
    }
    const siteBlocks = await CARDINAL.models.blocks.getSiteBlocks(siteId)
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

  /** Broken out so a test can mock it. */
  private async launchBrowser(): Promise<any> {
    return launchPuppeteerBrowser('diagramRenderPuppeteerMissing')
  }

  private async discardBrowser(browser: any): Promise<void> {
    await closeQuietly(browser, 'diagram render browser')
  }
}

export const diagramRender = new DiagramRender()
