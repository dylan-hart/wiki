import { svgMimeType } from './images.ts'

/**
 * Helpers turning the security settings an operator edits in the admin area into the shapes the
 * HTTP plugins expect.
 */

/** CORS modes offered by the admin area, in the order they appear there. */
export const CORS_MODES = ['OFF', 'REFLECT', 'HOSTNAMES', 'REGEX'] as const
export type CorsMode = (typeof CORS_MODES)[number]

/**
 * Every route that can serve a browser-executable document back to a requester — the admin-uploaded
 * site image (`controllers/site.ts`), a stored file addressed by path (`controllers/files.ts`), and
 * the same file addressed by ID (`api/assets.ts`'s `/content`) — attaches this to exactly those
 * responses whose declared type is SVG or HTML, and nothing else. A browser never executes script
 * markup found through an `<img src>`, so this is not what stops such a payload from running
 * embedded in the app's own UI; nothing needs to, because `<img>` already can't run it. What it
 * guards against is the request nothing else here controls: the same URL fetched *outside* an
 * `<img>` context — typed directly into the address bar, or loaded through
 * `<object>`/`<iframe>`/a same-origin top-level navigation — where a browser would otherwise treat
 * the response as an HTML-capable document and run whatever the file contains, in this origin, as
 * whoever is looking at it. (Verified manually against an uploaded SVG carrying a `<script>` payload
 * in both Chrome and Firefox: rendered via `<img src>` it never runs, matching the reasoning above
 * regardless of this header; opened directly in a new tab, this header's `sandbox` neutralizes it in
 * both browsers.)
 *
 * Exported as one constant, imported by all three call sites, so the policy cannot drift between
 * them.
 */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

/**
 * Whether a served MIME type is SVG- or HTML-typed, and therefore needs `SVG_CSP` attached to the
 * response that serves it. SVG is markup a browser renders and scripts; `text/html` and
 * `application/xhtml+xml` are what an uploaded `.html`/`.htm`/`.xhtml` file resolves to
 * (`mime.getType`, `models/assets.ts`) and are exactly as executable as an SVG opened directly.
 */
export function needsSvgCsp(mimeType: string): boolean {
  return (
    mimeType === svgMimeType || mimeType === 'text/html' || mimeType === 'application/xhtml+xml'
  )
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
