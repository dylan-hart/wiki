import { CustomError } from '../helpers/common.ts'

/** Engines this proxy knows how to speak POST to. Mermaid is deliberately not one of them — it
 *  already renders entirely client-side (`block-diagram`) and has no URL-size ceiling to escape. */
export type DiagramProxyEngine = 'kroki' | 'plantuml'
export type DiagramProxyFormat = 'svg' | 'png'

export interface DiagramProxyRequest {
  engine: DiagramProxyEngine
  /** The diagram's fenced source, exactly as an author would write it. */
  source: string
  /** Kroki only, required for it — which of Kroki's diagram languages `source` is written in. */
  diagramType?: string
  format?: DiagramProxyFormat
}

export interface DiagramProxyResult {
  contentType: string
  data: Buffer
}

/** The server each engine draws against unless the site's own block config names one of its own. */
const DEFAULT_SERVERS: Record<DiagramProxyEngine, string> = {
  kroki: 'https://kroki.io',
  plantuml: 'https://www.plantuml.com/plantuml'
}

/**
 * A source past this length is refused before any outbound request is made. Generous relative to the
 * GET-URL transport's 8,000-character ceiling this proxy exists to escape (`blocks/shared/url-limit.js`
 * — about 1.4 characters of encoded URL per character of source, so 8,000 was already a source well
 * under 6,000 characters), while still bounded: Fastify's own body-size backstop
 * (`WIKI.config.bodyParserLimit`, 5 MB default — `core/http/server.ts`) exists for the request as a
 * whole, not a clear diagram-specific explanation, so this is a narrower, better-explained ceiling in
 * front of it.
 */
const MAX_SOURCE_LENGTH = 200_000

/**
 * A rendered diagram past this many bytes is refused mid-download rather than buffered in full — see
 * {@link readCapped}. 10 MB is generous for an SVG or PNG diagram and small next to what an
 * intentionally hostile or misbehaving upstream could otherwise make this process hold in memory per
 * request.
 */
const MAX_RESPONSE_BYTES = 10_000_000

/**
 * How long the outbound render request is allowed to hang before this gives up on it — the same value
 * `models/diagramRender.ts#PLANTUML_FETCH_TIMEOUT_MS` and `models/liveData.ts#FETCH_TIMEOUT_MS` use for
 * the identical reason: an outbound request to a server this instance did not choose the destination
 * for at request time (only at admin-config time) must not be able to tie up a `limitRenders` slot
 * indefinitely.
 */
const FETCH_TIMEOUT_MS = 10000

/**
 * Diagram proxy model (OpenProject task 3228, Feature 3183)
 *
 * A shared, site-scoped, POST proxy for Kroki and PlantUML: streams a diagram's fenced source to the
 * configured engine server and returns the rendered image bytes, so `block-kroki`/`block-plantuml`
 * (OpenProject task 3229) no longer have to pack the source into a GET URL with an 8,000-character
 * ceiling (`blocks/shared/url-limit.js`).
 *
 * Deliberately a clean-room model rather than an extension of `models/diagramRender.ts`, even though
 * that model already renders PlantUML: the two solve different problems for different callers.
 * `DiagramRender#renderPlantuml` backs a session-authenticated, unscoped route (PDF export, MCP) and
 * mirrors the exact GET-URL transport `block-plantuml` used to use — deflate the source, encode it into
 * a URL, GET it. This proxy is what a reader's browser calls directly, anonymously, once per embedded
 * diagram, scoped to the site whose page embeds it; and it POSTs real request bodies instead of
 * encoding into a URL, which is the whole point. Sharing one model between the two would mean the
 * anonymous, page-reader-facing path inherits the authenticated path's assumptions (or vice versa) for
 * no reuse actually gained — the only thing genuinely shared between the two, resolving a site's
 * admin-configured PlantUML server, is a few lines neither is worth contorting around.
 *
 * `server` is never taken from the caller for either engine, only resolved from the site's own block
 * config (`resolveServer()`) the same way `DiagramRender#resolvePlantumlServer` already does — who may
 * point this instance's outbound request at an arbitrary URL is a separate, already-flagged gap
 * (Feature 365's vestigial per-block-instance `server` prop, Epic 3183's own description) this proxy
 * does not attempt to close, only avoids widening: it fetches exactly what an admin already configured
 * this site to fetch, nothing a page author or reader supplies.
 */
class DiagramProxy {
  /**
   * Render one diagram to a static image, dispatching on `request.engine`.
   *
   * @param siteId The site to resolve the engine's configured server against — see `resolveServer()`.
   * @throws {CustomError} `diagramProxyEmpty` (400) for blank source, `diagramProxyTooLarge` (413) for
   *   source over {@link MAX_SOURCE_LENGTH}, `diagramProxyMissingType` (400) for a Kroki request with
   *   no `diagramType`, `diagramProxyUnsupportedEngine` (400) for an unknown engine,
   *   `diagramProxyOffline` (503) when the instance is in offline mode, `diagramProxyUnreachable` (502)
   *   for a network failure, `diagramProxyFailed` (502) for a non-ok upstream response, and
   *   `diagramProxyResponseTooLarge` (502) for a response over {@link MAX_RESPONSE_BYTES}.
   */
  async render(siteId: string, request: DiagramProxyRequest): Promise<DiagramProxyResult> {
    if (!request.source?.trim()) {
      throw new CustomError('diagramProxyEmpty', 'There is no diagram source to render.', 400)
    }
    if (request.source.length > MAX_SOURCE_LENGTH) {
      throw new CustomError(
        'diagramProxyTooLarge',
        `This diagram's source is ${request.source.length.toLocaleString()} characters, over the ${MAX_SOURCE_LENGTH.toLocaleString()}-character limit rendering it on the server allows.`,
        413
      )
    }
    const format: DiagramProxyFormat = request.format === 'png' ? 'png' : 'svg'

    if (WIKI.config.offline) {
      throw new CustomError(
        'diagramProxyOffline',
        'Cardinal.js is in offline mode and cannot reach a diagram server to render this.',
        503
      )
    }

    if (request.engine === 'kroki') {
      return this.renderKroki(siteId, request, format)
    }
    if (request.engine === 'plantuml') {
      return this.renderPlantuml(siteId, request, format)
    }
    throw new CustomError(
      'diagramProxyUnsupportedEngine',
      `Unsupported diagram engine: ${request.engine}`,
      400
    )
  }

  /**
   * The server this site is configured to render `engine` against — its block row's site-level
   * `server` config value (`models/blocks.ts`'s `assertValidConfig` validates it at write time for
   * both engines, so it is trusted as-is here), or {@link DEFAULT_SERVERS}'s public default when the
   * site has none, has no such block row at all, or `siteId` itself is unknown.
   */
  private async resolveServer(engine: DiagramProxyEngine, siteId: string): Promise<string> {
    const siteBlocks = await WIKI.models.blocks.getSiteBlocks(siteId)
    const block = siteBlocks.find((b) => b.block === engine)
    const configured = typeof block?.config?.server === 'string' ? block.config.server.trim() : ''
    return configured || DEFAULT_SERVERS[engine]
  }

  /**
   * Kroki's own POST contract: a JSON body naming the source, the diagram language, and the wanted
   * output format, posted to the server root — see
   * https://docs.kroki.io/kroki/setup/usage/#POST (mirrored here from memory of that documented
   * shape, not fetched at build time).
   */
  private async renderKroki(
    siteId: string,
    request: DiagramProxyRequest,
    format: DiagramProxyFormat
  ): Promise<DiagramProxyResult> {
    const diagramType = request.diagramType?.trim()
    if (!diagramType) {
      throw new CustomError(
        'diagramProxyMissingType',
        'Kroki needs a diagram type to know how to read this source.',
        400
      )
    }
    const server = await this.resolveServer('kroki', siteId)
    const url = `${server.replace(/\/+$/, '')}/`
    const response = await this.fetchDiagram(
      'Kroki',
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: format === 'png' ? 'image/png' : 'image/svg+xml'
        },
        body: JSON.stringify({
          diagram_source: request.source,
          diagram_type: diagramType,
          output_format: format
        })
      },
      () => null
    )
    return { contentType: format === 'png' ? 'image/png' : 'image/svg+xml', data: response }
  }

  /**
   * PlantUML's implementation-specific POST form (Epic 3183's own scope note): the reference/official
   * `plantuml-server` (what `plantuml.com/plantuml` runs, and what most self-hosted deployments are)
   * accepts the raw diagram source as a plain-text POST body to `/{format}/`, rendering it the same way
   * its GET-URL form does. A self-hosted server on different, non-`plantuml-server` software may not
   * support this — a known limitation of this transport, not solved here.
   */
  private async renderPlantuml(
    siteId: string,
    request: DiagramProxyRequest,
    format: DiagramProxyFormat
  ): Promise<DiagramProxyResult> {
    const server = await this.resolveServer('plantuml', siteId)
    const url = `${server.replace(/\/+$/, '')}/${format}/`
    const response = await this.fetchDiagram(
      'PlantUML',
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: request.source
      },
      // -> Best-effort, the same as `DiagramRender#renderPlantuml` and `block-plantuml`'s own
      //    `_explainBody()`: a server behind a proxy that strips this header still answers, just
      //    without the specific reason.
      (headers) => headers.get('x-plantuml-diagram-error')
    )
    return { contentType: format === 'png' ? 'image/png' : 'image/svg+xml', data: response }
  }

  /**
   * The outbound POST every engine shares: bounded timeout, no redirect following (the same hardening
   * `DiagramRender#renderPlantuml` and `LiveData#resolve` apply to their own admin/author-influenced
   * fetches — a redirecting or hanging engine server must not be able to bounce this request elsewhere,
   * or hold a `limitRenders` slot open indefinitely), and a capped read of the response body.
   *
   * @param explainReason Reads an engine-specific reason for failure off the response headers, or
   *   `null` when there is none — folded into the thrown error ahead of the generic status-line message
   *   when present.
   */
  private async fetchDiagram(
    engineLabel: string,
    url: string,
    init: RequestInit,
    explainReason: (headers: Headers) => string | null
  ): Promise<Buffer> {
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
    } catch (err: any) {
      throw new CustomError(
        'diagramProxyUnreachable',
        `The ${engineLabel} server could not be reached: ${err.message}`,
        502
      )
    }
    const reason = explainReason(response.headers)
    if (reason) {
      throw new CustomError(
        'diagramProxyFailed',
        `${engineLabel} could not read this diagram: ${reason}`,
        422
      )
    }
    if (!response.ok) {
      throw new CustomError(
        'diagramProxyFailed',
        `The ${engineLabel} server answered ${response.status} ${response.statusText} for this diagram.`,
        502
      )
    }
    return this.readCapped(response, engineLabel)
  }

  /**
   * Read a response's body into memory, refusing once it grows past {@link MAX_RESPONSE_BYTES} —
   * checked as bytes actually arrive, not merely a `Content-Length` header, since that header is
   * absent from a chunked response and not something an upstream is obliged to send truthfully.
   */
  private async readCapped(response: Response, engineLabel: string): Promise<Buffer> {
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new CustomError(
        'diagramProxyResponseTooLarge',
        `The ${engineLabel} server's response is larger than this proxy accepts.`,
        502
      )
    }
    if (!response.body) {
      return Buffer.from(await response.arrayBuffer())
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          throw new CustomError(
            'diagramProxyResponseTooLarge',
            `The ${engineLabel} server's response is larger than this proxy accepts.`,
            502
          )
        }
        chunks.push(value)
      }
    } finally {
      // -> Best-effort: a reader already exhausted by `done: true` above answers a second `cancel()`
      //    with a resolved promise, and a reader that failed mid-read has nothing further to release.
      await reader.cancel().catch(() => {})
    }
    return Buffer.concat(chunks)
  }
}

export const diagramProxy = new DiagramProxy()
