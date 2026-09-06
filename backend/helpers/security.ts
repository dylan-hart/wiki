import { createHash } from 'node:crypto'

/**
 * Helpers turning the security settings an operator edits in the admin area into the shapes the
 * HTTP plugins expect.
 */

/** CORS modes offered by the admin area, in the order they appear there. */
export const CORS_MODES = ['OFF', 'REFLECT', 'HOSTNAMES', 'REGEX'] as const
export type CorsMode = (typeof CORS_MODES)[number]

/**
 * The session cookie's name, carrying the `__Host-` prefix (task 2109 / WP 2105 §2, §4): a browser
 * only honours that prefix when the cookie's actual NAME starts with it (`Secure`, `Path=/`, no
 * `Domain` are also required, and are set unconditionally alongside it in `index.ts`'s
 * `fastifySession` registration) — a value-only prefix would leave the name `wikiSession`, which a
 * sibling hostname on the same registrable domain could still plant a cookie under, defeating the
 * whole point. `@fastify/session`'s `cookiePrefix` option does not get this for free either, despite
 * the name — it only prefixes the session id *value* round-tripped through the store (an
 * express-session compatibility shim), never the `Set-Cookie` name itself; naming it via
 * `cookieName` is what actually produces a `__Host-` cookie. This is the name in effect when
 * `security.cookieSecure` is `true` (the default) — see `sessionCookieName()` below for the name a
 * live request actually uses, which is what every real consumer (the `fastifySession` registration,
 * logout's `clearCookie`, the same-origin `/_api/` guard, and the two places that forward the raw
 * cookie value to the PDF export's headless browser) calls instead of this constant directly.
 */
export const SESSION_COOKIE_NAME = '__Host-wikiSession'

/**
 * The name used instead of `SESSION_COOKIE_NAME` when `security.cookieSecure` is `false` — no
 * `__Host-` prefix, since that prefix requires the `Secure` attribute this mode deliberately drops
 * (a browser silently refuses to store a `__Host-`-named cookie missing it). See `sessionCookieName()`
 * below.
 */
export const SESSION_COOKIE_NAME_INSECURE = 'wikiSession'

/**
 * The session cookie name actually in effect, given `security.cookieSecure` (`base.yml`'s doc comment
 * on that key has the full story: task 2109 pinned `Secure`/`__Host-` unconditionally, wrongly
 * assuming a plain `http://localhost` dev instance still worked — `@fastify/session` refuses to ever
 * emit a `Secure`-flagged cookie over a connection it didn't itself see as TLS, loopback or not).
 * Every place that names the cookie on a *live request* — `index.ts`'s `fastifySession` registration,
 * logout's `clearCookie`, and the two places that forward the raw cookie value to the PDF export's
 * headless browser — calls this instead of the bare constant, so the choice can only ever drift in
 * one place. `shouldBlockCrossOriginApiRequest` below takes it as a parameter instead of calling this
 * directly, to stay a pure function with no `WIKI` dependency.
 */
export function sessionCookieName(): string {
  return WIKI.config.security?.cookieSecure === false
    ? SESSION_COOKIE_NAME_INSECURE
    : SESSION_COOKIE_NAME
}

/**
 * Whether an `Origin` header names the same host a request was addressed to. Used by the
 * cookie-authenticated same-origin check on state-changing `/_api/` requests below — needs "does
 * this request's stated origin agree with where it landed," and fails closed on anything that
 * doesn't parse or doesn't say so. The WebSocket handshake's own origin gate uses a related but
 * distinct check instead — see `helpers/common.ts#isSameOriginWebSocketHandshake` — since it also
 * accepts a handshake between two sites this same instance serves, not only an exact host match.
 *
 * Host only (hostname *and* port, via `URL#host`), not the full origin: deliberately not
 * scheme-sensitive, matching `models/passkeys.ts#resolveOrigin`'s own hostname-based comparison —
 * anchoring this to `req.protocol` would inherit the exact reverse-proxy blind spot
 * `models/security.ts#observeRequest` exists to catch (this instance's own view of its scheme is
 * wrong precisely when a trusted proxy terminates TLS and `trustProxy` is off), rather than closing
 * it. A genuine cross-site attacker cannot make their page's `Origin` say the wiki's own host no
 * matter what scheme either side used, so the host comparison alone is what's actually load-bearing
 * here.
 *
 * @param origin The `Origin` header, if the client sent one — missing or unparseable both fail
 *               closed (`false`), since a browser-driven state-changing request always sends one.
 * @param host The host the request was addressed to (`req.host`, or the raw `Host` header for a
 *             WebSocket upgrade that never reaches Fastify's own request object).
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

/** The slice of a Fastify `FastifyRequest` the same-origin `/_api/` check below actually reads. */
export interface SameOriginApiCheckRequest {
  url: string
  method: string
  apiKey?: unknown
  cookies?: Record<string, string | undefined>
  headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[] }
  host?: string
}

/**
 * Whether a request under `/_api/` should be refused for failing the same-origin check (task 2118 /
 * WP 2105 §3) -- `index.ts`'s `onRequest` hook is a thin wrapper over this, so the real behavior a
 * route sees is exactly what this function decides and can be exercised here with no Fastify
 * instance, database, or route registration needed at all.
 *
 * `SameSite=Lax` (`index.ts`'s `fastifySession` registration) does not cover a same-site-but-
 * different-origin attacker -- a page on a sibling hostname is "same-site" to this wiki for cookie
 * purposes but not the wiki's own origin, and `Lax` still attaches the cookie to a top-level form
 * navigation either way. A state-changing request riding on the session cookie alone -- no verified
 * bearer token -- has to positively confirm it originated here.
 *
 * Returns `false` (allow) for: a non-`/_api/` request, `GET`/`HEAD` (never state-changing), a
 * bearer-authenticated request (`req.apiKey` set -- not browser-driven, carries no ambient
 * credential a foreign page could ride on), and a request carrying no session cookie at all
 * (nothing here to protect). Otherwise fails closed: allowed only when `Sec-Fetch-Site:
 * same-origin` is present (checked first -- sent by every modern browser and more precise than
 * `Origin`, since it survives an `Origin`-suppressing redirect chain) or `Origin` agrees with the
 * request's own host.
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
 * Locks down a response that is otherwise an active document — an SVG (which can carry `<script>`
 * and event-handler attributes) or an HTML/XHTML file — so that opening it directly (typed into the
 * address bar, or reached through `<object>`/`<iframe>`/a same-origin top-level navigation) cannot
 * run anything in this origin. `X-Content-Type-Options: nosniff` does not help here: the declared
 * type is honestly `image/svg+xml` or `text/html`, which a browser treats as a document either way.
 * A browser never executes script markup found through an `<img src>` either way, so this is not
 * what stops such a payload from running embedded in the app's own UI; nothing needs to, because
 * `<img>` already can't run it. (Verified manually against an uploaded SVG carrying a `<script>`
 * payload in both Chrome and Firefox: rendered via `<img src>` it never runs, matching the reasoning
 * above regardless of this header; opened directly in a new tab, this header's `sandbox` neutralizes
 * it in both browsers.)
 *
 * Originally local to `controllers/site.ts` (which attaches it to admin-uploaded logo/favicon SVGs)
 * and moved here so `controllers/files.ts` and `api/assets.ts`'s `/content` route reference the
 * exact same constant rather than a copy that could drift (OpenProject #2157).
 */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

/**
 * Extensions whose declared MIME type is a document a browser will parse and can execute
 * script/markup within, rather than passive image or binary data — SVG and HTML/XHTML. Every route
 * that serves stored asset bytes by extension (`controllers/files.ts`, `api/assets.ts`'s `/content`)
 * checks this before deciding whether to attach `SVG_CSP`.
 */
const ACTIVE_DOCUMENT_EXTS = new Set(['svg', 'html', 'htm', 'xhtml'])

/** Whether a served asset needs `SVG_CSP` attached, based on its stored extension. */
export function needsSvgCsp(fileExt: string): boolean {
  return ACTIVE_DOCUMENT_EXTS.has(fileExt.toLowerCase())
}

/**
 * Directive names recognised by the CSP3 spec (fetch, document, navigation, reporting and
 * trusted-types directives — https://www.w3.org/TR/CSP3/#csp-directives) plus the two long-deprecated
 * ones (`block-all-mixed-content`, `plugin-types`) some still-supported browsers accept. Anything
 * outside this set is almost certainly a typo, which is exactly the case `parseCspDirectives` is
 * built to catch: a misspelled `srcipt-src` previously stored (and enforced) silently as nothing,
 * rather than refusing the save.
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
 * Turn a Content-Security-Policy string into helmet's directives object.
 *
 * `default-src 'self'; img-src * data:` becomes
 * `{ 'default-src': ["'self'"], 'img-src': ['*', 'data:'] }`. A directive with no value, such as
 * `upgrade-insecure-requests`, maps to an empty list, which is how helmet expresses it too.
 *
 * @throws {Error} naming the offending token when a chunk's directive name is not one of
 * `CSP_DIRECTIVE_NAMES` — `models/security.ts#validate` is what turns this into a rejected save
 * rather than a silently-narrower policy.
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
 * CSP `script-src` hash sources (`'sha256-<base64>'`, one per match) for every inline `<script>`
 * block in `html` that carries no `src` attribute.
 *
 * The app shell always ships two of these — `frontend/index.html`'s own Temporal-polyfill
 * feature-detect check, and `temporalPolyfillChunkPlugin`'s substituted chunk-url assignment
 * (`frontend/src/build/temporalPolyfillChunk.js`) — and a `script-src 'self'` policy with no
 * `'unsafe-inline'` (`base.yml`'s own shipped `cspDirectives` default) refuses both outright:
 * `enforceCsp: true` broke the app shell itself, caught by `e2e/tests/csp.spec.js`. A hash source
 * is exact per the CSP3 spec — the raw UTF-8 text content between the tags, unmodified — and needs
 * no per-request machinery, since the app shell is a build artifact: `index.ts` computes this once,
 * from the same built `assets/index.html` `helpers/appShell.ts` serves, which is why a change here
 * needs the same restart every other setting in the CSP registration already does.
 *
 * Deliberately a plain regex over the raw HTML rather than a full parser: this only ever runs
 * against `index.ts`'s own known-shape build output, not arbitrary/untrusted markup.
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
 * The `origin` option for `@fastify/cors`, from the configured mode.
 *
 * `false` means no CORS headers at all, i.e. same-origin only, which is both the `OFF` mode and what
 * anything unrecognised degrades to — a misconfiguration should not end up more permissive than the
 * operator asked for.
 */
/**
 * `REFLECT` echoes back whatever `Origin` header the request sent, which is safe to combine with
 * an open method/header list ONLY because `@fastify/cors` is registered without `credentials:
 * true` — cookies and `Authorization` aren't retained by the browser across origins either way, so
 * reflecting the origin doesn't hand a third-party site an authenticated session. If a future
 * change adds `credentials: true` to that registration (e.g. to support cookie-based cross-origin
 * auth), `REFLECT` must be reconsidered first: reflect-plus-credentials lets ANY origin read an
 * authenticated response, which is the textbook CORS misconfiguration. Restrict to `HOSTNAMES` or
 * `REGEX` before shipping that combination.
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
          //    (`https://wiki.example.com`) with `===`, so a bare hostname an operator enters here
          //    can never match — normalise it into a full `https://` origin. An entry that already
          //    names a scheme (`://` present) is left as written.
          .map((entry) => (entry.includes('://') ? entry : `https://${entry}`))
      )
    case 'REGEX':
      try {
        // -> `@fastify/cors` runs `.test()` against the complete `Origin` header, so an
        //    unanchored pattern also matches as a substring anywhere in it (e.g.
        //    `https://wiki.example.com.attacker.test` or `https://evil.test/?x=wiki.example.com`
        //    both satisfy a bare `wiki\.example\.com`). Anchor it on the operator's behalf,
        //    stripping any `^`/`$` they already added so a pattern they anchored themselves is
        //    left as written rather than double-wrapped. The remaining body is wrapped in a
        //    non-capturing group before anchoring — `^A|B$` only anchors the left edge of the
        //    first alternative and the right edge of the last one, leaving every other
        //    top-level `|` alternative (and the last one's left edge) unanchored and still
        //    substring-matchable; `^(?:A|B)$` anchors the whole expression regardless of
        //    top-level alternation.
        let pattern = security.corsConfig ?? ''
        if (pattern.startsWith('^')) {
          pattern = pattern.slice(1)
        }
        if (pattern.endsWith('$')) {
          pattern = pattern.slice(0, -1)
        }
        return new RegExp(`^(?:${pattern})$`)
      } catch (err: any) {
        WIKI.logger.warn(
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
 * The full option object passed to `@fastify/cors`. This registration is global — it also covers
 * `/_render`, `/_thumb`, `/_assets` and friends, which legitimately want to be embeddable
 * cross-origin — rather than split so `/_api` gets its own policy. `/_api` alone drives the method
 * list here: 55+ routes across `backend/api/*.ts` use `PUT`, `PATCH` or `DELETE`, and a
 * cross-origin API client sends `Authorization` (Bearer token) and `Content-Type` (JSON body),
 * both of which must be in `allowedHeaders` or the browser's preflight `OPTIONS` request fails
 * before the real request is ever sent. Kept as one plain object (rather than inlined at the
 * `app.register` call) so `methods`/`allowedHeaders` can be covered by a unit test — the plugin
 * registration itself is wiring, not logic, and isn't worth spinning up a Fastify instance to test.
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
