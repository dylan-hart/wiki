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
 * whole point. Every place that names the cookie literally — the `fastifySession` registration, the
 * `clearCookie` call in `api/authentication.ts`'s logout, the same-origin `/_api/` guard below, and
 * `models/pdfExport.ts`'s loopback cookie forward to the headless-browser export — imports this
 * constant instead, so the name can only ever drift in one place.
 */
export const SESSION_COOKIE_NAME = '__Host-wikiSession'

/**
 * Whether an `Origin` header names the same host a request was addressed to. Shared by the
 * cookie-authenticated same-origin check on state-changing `/_api/` requests (`index.ts`) and the
 * `verifyClient` gate on the single `fastifyWebsocket` registration (`index.ts`) — both need "does
 * this request's stated origin agree with where it landed," and both fail closed on anything that
 * doesn't parse or doesn't say so.
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
export function shouldBlockCrossOriginApiRequest(req: SameOriginApiCheckRequest): boolean {
  if (
    !req.url.startsWith('/_api/') ||
    req.method === 'GET' ||
    req.method === 'HEAD' ||
    req.apiKey ||
    !req.cookies?.[SESSION_COOKIE_NAME]
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
 * The `verifyClient` callback for the single `fastifyWebsocket` registration in `index.ts` (task
 * 2120 / WP 2105 §5) -- exported here, rather than written inline at the registration, so it can be
 * exercised directly (including against a real `ws` handshake, which is what actually proves a
 * foreign origin is refused before either websocket controller's own `req.session` check ever
 * runs) with no need to duplicate the callback body in a test.
 *
 * A WebSocket handshake is not subject to the same-origin policy and is never preflighted, so CORS
 * governs neither it nor the frames after it, and both current routes
 * (`controllers/terminal.ts`, `controllers/collab.ts`) authorize purely from `req.session` -- an
 * ambient credential a foreign page could ride on the same way it could a form POST. `ws` hands
 * this the raw Node `http.IncomingMessage` for the upgrade request as `info.req`, since Fastify's
 * own request object (and therefore its hooks) does not exist yet for this connection.
 */
export function websocketVerifyClient(
  info: { req: { headers: { origin?: string; host?: string } } },
  callback: (result: boolean, code?: number, message?: string) => void
): void {
  if (isSameOriginHeader(info.req.headers.origin, info.req.headers.host)) {
    callback(true)
  } else {
    callback(false, 403, 'Cross-origin WebSocket handshake blocked')
  }
}

/**
 * Turn a Content-Security-Policy string into helmet's directives object.
 *
 * `default-src 'self'; img-src * data:` becomes
 * `{ 'default-src': ["'self'"], 'img-src': ['*', 'data:'] }`. A directive with no value, such as
 * `upgrade-insecure-requests`, maps to an empty list, which is how helmet expresses it too.
 */
export function parseCspDirectives(value: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {}
  for (const chunk of value.split(';')) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean)
    const name = parts.shift()
    if (!name) {
      continue
    }
    directives[name.toLowerCase()] = parts
  }
  return directives
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
      return (security.corsConfig ?? '')
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    case 'REGEX':
      try {
        return new RegExp(security.corsConfig ?? '')
      } catch (err: any) {
        WIKI.logger.warn(
          `The CORS regex pattern is invalid (${err.message}) — falling back to same-origin only.`
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
