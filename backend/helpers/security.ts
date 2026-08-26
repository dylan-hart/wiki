/**
 * Helpers turning the security settings an operator edits in the admin area into the shapes the
 * HTTP plugins expect.
 */

/** CORS modes offered by the admin area, in the order they appear there. */
export const CORS_MODES = ['OFF', 'REFLECT', 'HOSTNAMES', 'REGEX'] as const
export type CorsMode = (typeof CORS_MODES)[number]

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
