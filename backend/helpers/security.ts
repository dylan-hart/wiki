import { createHash } from 'node:crypto'

export const CORS_MODES = ['OFF', 'REFLECT', 'HOSTNAMES', 'REGEX'] as const
export type CorsMode = (typeof CORS_MODES)[number]

/**
 * A browser honours the `__Host-` prefix only on the cookie's NAME (and only with `Secure`,
 * `Path=/` and no `Domain`). `@fastify/session`'s `cookiePrefix` prefixes the session id VALUE,
 * never the `Set-Cookie` name, so the prefix has to come through `cookieName`. Anything naming the
 * cookie on a live request calls `sessionCookieName()`, not this constant.
 */
export const SESSION_COOKIE_NAME = '__Host-wikiSession'

/**
 * No `__Host-` prefix when `security.cookieSecure` is `false`: the prefix requires `Secure`, and a
 * browser silently refuses to store a `__Host-` cookie that lacks it.
 */
export const SESSION_COOKIE_NAME_INSECURE = 'wikiSession'

/**
 * `base.yml`'s comment on `security.cookieSecure` has why the insecure mode exists.
 * `shouldBlockCrossOriginApiRequest` takes the name as a parameter instead of calling this, to stay
 * pure with no `CARDINAL` dependency.
 */
export function sessionCookieName(): string {
  return CARDINAL.config.security?.cookieSecure === false
    ? SESSION_COOKIE_NAME_INSECURE
    : SESSION_COOKIE_NAME
}

/**
 * A missing or unparseable `Origin` fails closed: a browser-driven state-changing request always
 * sends one. The WebSocket handshake uses `helpers/common.ts#isSameOriginWebSocketHandshake`
 * instead, which also accepts another site this instance serves.
 *
 * Compares `URL#host` (hostname and port), deliberately not the scheme: this instance's view of its
 * own scheme is wrong when a proxy terminates TLS and `trustProxy` is off, and a cross-site
 * attacker cannot make their page's `Origin` name the wiki's host whatever the scheme.
 */
export function isSameOriginHeader(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) {
    return false
  }
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export interface SameOriginApiCheckRequest {
  url: string
  method: string
  apiKey?: unknown
  cookies?: Record<string, string | undefined>
  headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[] }
  host?: string
}

/**
 * `SameSite=Lax` does not cover a same-site, different-origin attacker: a page on a sibling
 * hostname is "same-site" for cookie purposes, and `Lax` still attaches the cookie to a top-level
 * form navigation. A state-changing request riding on the session cookie alone therefore has to
 * positively confirm it originated here, and fails closed otherwise.
 *
 * A bearer-authenticated request is exempt (no ambient credential a foreign page could ride on),
 * as is one with no session cookie. `Sec-Fetch-Site` is checked before `Origin` because it
 * survives an `Origin`-suppressing redirect chain.
 */
export function shouldBlockCrossOriginApiRequest(
  req: SameOriginApiCheckRequest,
  cookieName: string = SESSION_COOKIE_NAME
): boolean {
  if (
    !req.url.startsWith('/_api/') ||
    req.method === 'GET' ||
    req.method === 'HEAD' ||
    req.apiKey ||
    !req.cookies?.[cookieName]
  ) {
    return false
  }
  const secFetchSite = req.headers['sec-fetch-site']
  if ((Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite) === 'same-origin') {
    return false
  }
  const origin = req.headers.origin
  return !isSameOriginHeader(Array.isArray(origin) ? origin[0] : origin, req.host)
}

/**
 * For a response that is an active document (SVG, HTML/XHTML), so that opening it directly — the
 * address bar, `<object>`/`<iframe>`, a same-origin top-level navigation — cannot run anything in
 * this origin. `nosniff` does not help: the declared type is honestly a document type. `<img src>`
 * never executes script markup, so embedding in the app's own UI is not what this guards.
 */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

const ACTIVE_DOCUMENT_EXTS = new Set(['svg', 'html', 'htm', 'xhtml'])

export function needsSvgCsp(fileExt: string): boolean {
  return ACTIVE_DOCUMENT_EXTS.has(fileExt.toLowerCase())
}

/**
 * The CSP3 directive names (https://www.w3.org/TR/CSP3/#csp-directives) plus two deprecated ones
 * (`block-all-mixed-content`, `plugin-types`) some supported browsers still accept. A name outside
 * this set is almost certainly a typo (`srcipt-src`), which would otherwise be enforced as nothing.
 */
export const CSP_DIRECTIVE_NAMES = new Set([
  'base-uri',
  'block-all-mixed-content',
  'child-src',
  'connect-src',
  'default-src',
  'fenced-frame-src',
  'font-src',
  'form-action',
  'frame-ancestors',
  'frame-src',
  'img-src',
  'manifest-src',
  'media-src',
  'navigate-to',
  'object-src',
  'plugin-types',
  'prefetch-src',
  'report-to',
  'report-uri',
  'require-trusted-types-for',
  'sandbox',
  'script-src',
  'script-src-attr',
  'script-src-elem',
  'style-src',
  'style-src-attr',
  'style-src-elem',
  'trusted-types',
  'upgrade-insecure-requests',
  'worker-src'
])

/**
 * A Content-Security-Policy string as helmet's directives object. A valueless directive
 * (`upgrade-insecure-requests`) maps to an empty list, which is how helmet expresses it too.
 *
 * @throws {Error} on a directive name outside `CSP_DIRECTIVE_NAMES`, which
 * `models/security.ts#validate` turns into a rejected save.
 */
export function parseCspDirectives(value: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {}
  for (const chunk of value.split(';')) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean)
    const name = parts.shift()
    if (!name) {
      continue
    }
    const key = name.toLowerCase()
    if (!CSP_DIRECTIVE_NAMES.has(key)) {
      throw new Error(`Unknown Content-Security-Policy directive "${name}".`)
    }
    directives[key] = parts
  }
  return directives
}

/**
 * CSP `script-src` hash sources (`'sha256-<base64>'`) for every inline `<script>` in `html` with no
 * `src`. The app shell ships inline scripts the shipped `script-src 'self'` policy would refuse; a
 * hash is exact per CSP3 — the raw UTF-8 text between the tags — and, the app shell being a build
 * artifact, needs no per-request nonce machinery.
 *
 * A plain regex rather than a parser: this only ever runs against the project's own build output,
 * never untrusted markup.
 */
export function inlineScriptHashSources(html: string): string[] {
  const hashes: string[] = []
  const scriptTagRe = /<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi
  for (const match of html.matchAll(scriptTagRe)) {
    const content = match[1]
    if (!content) {
      continue
    }
    const hash = createHash('sha256').update(content, 'utf8').digest('base64')
    hashes.push(`'sha256-${hash}'`)
  }
  return hashes
}

/**
 * The `origin` option for `@fastify/cors`. `false` means no CORS headers at all (same-origin only):
 * both the `OFF` mode and what anything unrecognised degrades to, so a misconfiguration is never
 * more permissive than the operator asked for.
 *
 * `REFLECT` is safe with an open method/header list ONLY because `@fastify/cors` is registered
 * without `credentials: true`. Reflect-plus-credentials lets ANY origin read an authenticated
 * response, so `REFLECT` has to go before `credentials: true` is ever added.
 */
export function corsOrigin(security: {
  corsMode?: string
  corsConfig?: string
}): boolean | string[] | RegExp {
  switch (security.corsMode) {
    case 'REFLECT':
      return true
    case 'HOSTNAMES':
      return (
        (security.corsConfig ?? '')
          .split(/[\n,]/)
          .map((entry) => entry.trim())
          .filter(Boolean)
          // -> `@fastify/cors` compares this list against the complete `Origin` header
          //    (`https://wiki.example.com`) with `===`, so a bare hostname can never match.
          .map((entry) => (entry.includes('://') ? entry : `https://${entry}`))
      )
    case 'REGEX':
      try {
        // -> `@fastify/cors` runs `.test()` against the complete `Origin` header, so an
        //    unanchored pattern matches as a substring (`https://wiki.example.com.attacker.test`
        //    satisfies a bare `wiki\.example\.com`). Anchor it on the operator's behalf, and
        //    group the body first: `^A|B$` anchors only the outer edges of the first and last
        //    alternatives, `^(?:A|B)$` the whole expression.
        let pattern = security.corsConfig ?? ''
        if (pattern.startsWith('^')) {
          pattern = pattern.slice(1)
        }
        if (pattern.endsWith('$')) {
          pattern = pattern.slice(0, -1)
        }
        return new RegExp(`^(?:${pattern})$`)
      } catch (err: any) {
        CARDINAL.logger.warn(
          'config',
          'the CORS regex pattern is invalid, falling back to same-origin only',
          { error: err }
        )
        return false
      }
    default:
      return false
  }
}

/**
 * `null` for an empty embed allowlist (no embedding). `'self'` is always included: the allowlist
 * says who ELSE may embed the site, and does not replace the wiki framing its own pages.
 */
export function frameAncestorsDirective(origins: string[]): string | null {
  if (!origins.length) {
    return null
  }
  return `frame-ancestors 'self' ${origins.join(' ')}`
}

/**
 * `existingCsp` is whatever `reply.getHeader()` hands back: a string, an array, or nothing when
 * `security.enforceCsp` is off, in which case the directive becomes the whole header value.
 */
export function appendCspDirective(
  existingCsp: string | string[] | number | undefined,
  directive: string
): string {
  const existing = Array.isArray(existingCsp) ? existingCsp.join('; ') : existingCsp
  return existing ? `${existing}; ${directive}` : directive
}

/**
 * The `@fastify/cors` registration is global, so it also covers `/_render`, `/_thumb`, `/_assets`
 * and friends, which want to be embeddable cross-origin. `/_api` alone drives the method list, and
 * a cross-origin API client sends `Authorization` and `Content-Type`: both must be in
 * `allowedHeaders` or the browser's preflight fails before the real request is sent.
 */
export function corsOptions(security: { corsMode?: string; corsConfig?: string }): {
  origin: boolean | string[] | RegExp
  methods: string[]
  allowedHeaders: string[]
} {
  return {
    origin: corsOrigin(security),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type']
  }
}
