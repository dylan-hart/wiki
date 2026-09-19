import { CustomError } from '../helpers/common.ts'

/** Engines this proxy knows how to speak POST to. Mermaid is deliberately not one of them — it
 *  already renders entirely client-side (`block-diagram`) and has no URL-size ceiling to escape. */
export type DiagramProxyEngine = 'kroki' | 'plantuml'
export type DiagramProxyFormat = 'svg' | 'png'

export interface DiagramProxyRequest {
  engine: DiagramProxyEngine
  source: string
  /** Kroki only, required for it — which of Kroki's diagram languages `source` is written in. */
  diagramType?: string
  format?: DiagramProxyFormat
}

export interface DiagramProxyResult {
  contentType: string
  data: Buffer
}

/** What each engine draws against unless the site's own block config names a server of its own. */
const DEFAULT_SERVERS: Record<DiagramProxyEngine, string> = {
  kroki: 'https://kroki.io',
  plantuml: 'https://www.plantuml.com/plantuml'
}

/**
 * A source past this length is refused before any outbound request is made. Generous, but still
 * bounded: Fastify's own body-size backstop (`CARDINAL.config.bodyParserLimit`) covers the request as
 * a whole with no diagram-specific explanation, so this is a narrower, better-explained ceiling in
 * front of it.
 */
const MAX_SOURCE_LENGTH = 200_000

/**
 * A rendered diagram past this many bytes is refused mid-download rather than buffered in full — a
 * hostile or misbehaving upstream must not decide how much this process holds in memory per request.
 */
const MAX_RESPONSE_BYTES = 10_000_000

/**
 * An outbound request to a server this instance did not pick the destination for at request time
 * (only at admin-config time) must not be able to tie up a `limitRenders` slot indefinitely.
 */
const FETCH_TIMEOUT_MS = 10000

/**
 * Diagram proxy model
 *
 * A shared, site-scoped, POST proxy for Kroki and PlantUML: streams a diagram's fenced source to the
 * configured engine server and returns the rendered image bytes, so `block-kroki`/`block-plantuml`
 * do not have to pack the source into a GET URL with an 8,000-character ceiling.
 *
 * Deliberately separate from `models/diagramRender.ts`, which also renders PlantUML: that backs a
 * session-authenticated, unscoped route (PDF export, MCP) over the GET-URL transport, while this is
 * what a reader's browser calls directly and anonymously, once per embedded diagram, scoped to the
 * site whose page embeds it.
 *
 * `server` is never taken from the caller for either engine, only resolved from the site's own block
 * config: this fetches exactly what an admin already configured this site to fetch, nothing a page
 * author or reader supplies.
 */
class DiagramProxy {
  /** Render one diagram; `siteId` is what the engine's configured server is resolved against. */
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

    if (CARDINAL.config.offline) {
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
   * `server` value, which `models/blocks.ts`'s `assertValidConfig` already validated at write time,
   * so it is trusted as-is here. Falls back to {@link DEFAULT_SERVERS} for a site with no such value,
   * no such block row, or an unknown `siteId`.
   */
  private async resolveServer(engine: DiagramProxyEngine, siteId: string): Promise<string> {
    const siteBlocks = await CARDINAL.models.blocks.getSiteBlocks(siteId)
    const block = siteBlocks.find((b) => b.block === engine)
    const configured = typeof block?.config?.server === 'string' ? block.config.server.trim() : ''
    return configured || DEFAULT_SERVERS[engine]
  }

  /**
   * Kroki's own POST contract: a JSON body naming the source, the diagram language and the wanted
   * output format, posted to the server root — https://docs.kroki.io/kroki/setup/usage/#POST.
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
   * PlantUML's implementation-specific POST form: the reference `plantuml-server` (what
   * `plantuml.com/plantuml` runs, and what most self-hosted deployments are) accepts the raw diagram
   * source as a plain-text POST body to `/{format}/`. A self-hosted server on different software may
   * not — a known limitation of this transport, not solved here.
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
      // -> Best-effort: a server behind a proxy that strips this header still answers, just without
      //    the specific reason.
      (headers) => headers.get('x-plantuml-diagram-error')
    )
    return { contentType: format === 'png' ? 'image/png' : 'image/svg+xml', data: response }
  }

  /**
   * The outbound POST every engine shares: bounded timeout, no redirect following — a redirecting or
   * hanging engine server must not be able to bounce this request elsewhere or hold a `limitRenders`
   * slot open indefinitely — and a capped read of the response body.
   *
   * @param explainReason Reads an engine-specific reason for failure off the response headers, or
   *   `null` when there is none — preferred over the generic status-line message when present.
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
   * counted as bytes actually arrive, not merely from `Content-Length`, which a chunked response
   * omits and no upstream is obliged to send truthfully.
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
      // -> Best-effort: a reader already exhausted by `done: true` resolves a second `cancel()`, and
      //    one that failed mid-read has nothing further to release.
      await reader.cancel().catch(() => {})
    }
    return Buffer.concat(chunks)
  }
}

export const diagramProxy = new DiagramProxy()
