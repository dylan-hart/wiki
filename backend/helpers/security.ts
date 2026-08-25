/**
 * Helpers turning the security settings an operator edits in the admin area into the shapes the
 * HTTP plugins expect.
 */

/**
 * The Content-Security-Policy attached to any response whose body is SVG or HTML — a document type a
 * browser will run as active content if it is ever opened directly (a top-level navigation, or an
 * `<iframe>`/`<object>`/`<embed>`) rather than merely referenced from an `<img src>`, which never
 * executes markup regardless of headers. `sandbox` with no allowances disables scripts, forms,
 * top-level navigation and popups; `default-src 'none'` refuses every other kind of resource load;
 * `style-src 'unsafe-inline'` is the one allowance, because inline `style="…"` is common and
 * harmless once script execution is already off. Originally local to `controllers/site.ts` (the
 * admin-uploaded logo/favicon path) and verified there against a `<script>`-carrying SVG in both
 * Chrome and Firefox — opened directly in a new tab, `sandbox` neutralized it in both. Exported here
 * so every response serving SVG/HTML-typed bytes shares the exact same string rather than each
 * serving site defining (and risking drifting) its own.
 */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

/**
 * MIME types a browser treats as an HTML-capable *document* rather than passive data — i.e. types
 * that can carry a `<script>` or an event-handler attribute that actually runs when the response is
 * opened directly. `svgMimeType` (`image/svg+xml`) is the one an ordinary asset upload can produce
 * with no admin permission at all; `text/html` and `application/xhtml+xml` are reachable the same
 * way once an `.html`/`.xhtml` upload is stored, since nothing on the upload path restricts the
 * extension. Anything else `mime.getType()` resolves — images, PDFs, archives — is not a browser
 * scripting context regardless of headers, so it does not need this CSP.
 */
export function isDangerousInlineType(mimeType: string): boolean {
  return (
    mimeType === 'image/svg+xml' || mimeType === 'text/html' || mimeType === 'application/xhtml+xml'
  )
}

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
 * Every directive name a browser actually recognises in a `Content-Security-Policy` header — fetch
 * directives, document/navigation directives, and the two reporting directives. Kept as the allowlist
 * `models/security.ts#validate` checks a saved `cspDirectives` string against, so a typo (`scirpt-src`,
 * or a directive from an unrelated header like `x-frame-options`) is caught at save time rather than
 * stored and silently doing nothing once an operator turns `enforceCsp` on. Source: the W3C CSP3
 * directive registry plus the still-widely-supported CSP2 `plugin-types`/`block-all-mixed-content`.
 */
export const KNOWN_CSP_DIRECTIVES = new Set([
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
 * The first directive name in a `cspDirectives` string this browser does not actually recognise, or
 * `null` when every directive parsed out of it is a real one. Used by `models/security.ts#validate`
 * to refuse a save with a typo rather than storing a policy that quietly leaves that one aspect
 * unprotected.
 */
export function findUnknownCspDirective(value: string): string | null {
  for (const name of Object.keys(parseCspDirectives(value))) {
    if (!KNOWN_CSP_DIRECTIVES.has(name)) {
      return name
    }
  }
  return null
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
