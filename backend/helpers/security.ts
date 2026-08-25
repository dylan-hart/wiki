/**
 * Helpers turning the security settings an operator edits in the admin area into the shapes the
 * HTTP plugins expect.
 */

/** CORS modes offered by the admin area, in the order they appear there. */
export const CORS_MODES = ['OFF', 'REFLECT', 'HOSTNAMES', 'REGEX'] as const
export type CorsMode = (typeof CORS_MODES)[number]

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

/**
 * Whether a cookie-authenticated, state-changing `/_api` request's declared provenance agrees with
 * the host it was addressed to (task 2118).
 *
 * `SameSite=Lax` (see `models/sessions.ts`'s cookie options) still lets a top-level cross-site
 * navigation — a plain link or form submit from an attacker's own origin — carry the session cookie
 * along, which is enough for a CSRF `POST`/`PUT`/`PATCH`/`DELETE`. Neither header this checks is
 * something an attacker's page can suppress or forge: `Origin` is a forbidden header name a page's
 * own JS cannot set on a request, and `Sec-Fetch-Site` is appended by the browser itself. `Origin` is
 * preferred when present since it is the more universally-supported of the two; `Sec-Fetch-Site` is
 * the fallback for a request that omits `Origin` (a plain GET-turned-into-something-else is not the
 * concern here, but some non-CORS same-origin requests — and older browsers — send no `Origin` on
 * `POST`). A request with neither is refused rather than assumed safe: `models/passkeys.ts`'s
 * `resolveOrigin` assumes a missing `Origin` is a legitimate non-browser API client for that reason,
 * but this check runs on *cookie*-authenticated traffic, where a non-browser client has no cookie jar
 * to have picked up a session cookie from in the first place — so there's no legitimate case being
 * turned away, and the fail-closed default is free.
 *
 * `host` is `req.host` (the raw `Host`/`:authority` header, port included), not `req.hostname`
 * (which fastify strips the port from) — full origin equality needs the port too, unlike the RP-ID
 * comparison `resolveOrigin` makes for WebAuthn.
 */
export function isSameOriginRequest(
  headers: { origin?: string; 'sec-fetch-site'?: string },
  host: string
): boolean {
  const origin = headers.origin
  if (origin !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    return parsed.host === host
  }
  const secFetchSite = headers['sec-fetch-site']
  if (secFetchSite !== undefined) {
    return secFetchSite === 'same-origin'
  }
  return false
}
