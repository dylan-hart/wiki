import type { FastifyInstance } from 'fastify'
import { CORS_MODES } from '../../helpers/security.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * SECURITY CONFIG - Used both ways: as the response, and as a partial update body
   */
  app.addSchema({
    $id: 'SecurityConfig',
    type: 'object',
    properties: {
      corsMode: {
        type: 'string',
        enum: CORS_MODES,
        description:
          '`OFF` sends no CORS headers at all, i.e. same-origin only. `REFLECT` echoes the request origin back.'
      },
      corsConfig: {
        type: 'string',
        maxLength: 8192,
        description:
          'Hostnames, one per line or comma-separated, for `HOSTNAMES` mode; a regular expression for `REGEX` mode. Ignored otherwise.'
      },
      enforceCsp: {
        type: 'boolean'
      },
      cspDirectives: {
        type: 'string',
        maxLength: 8192,
        description: "Directives separated by `;`, e.g. `default-src 'self'; img-src * data:`."
      },
      enforceHsts: {
        type: 'boolean'
      },
      hstsDuration: {
        type: 'integer',
        minimum: 0,
        description: 'Seconds. Must be greater than zero when HSTS is enforced.'
      },
      disallowIframe: {
        type: 'boolean',
        description: '`X-Frame-Options: DENY` when on, `SAMEORIGIN` when off.'
      },
      enforceSameOriginReferrerPolicy: {
        type: 'boolean',
        description: '`Referrer-Policy: same-origin` when on, `no-referrer` when off.'
      },
      disallowOpenRedirect: {
        type: 'boolean',
        description:
          'When on (the default), a group/site login/logout redirect and the `?redirect=` query parameter on a provider login must name a path on this wiki; an absolute URL to another host is refused. Turning it off additionally permits a complete `https?://` URL. Every one of those fields refuses a `javascript:`/`data:`/scheme-relative target regardless of this setting -- it only ever widens what a legitimate absolute redirect may target. Read live on each request via `helpers/redirectTarget.ts#absoluteRedirectsAllowed()`, unlike most of this card — flipping it applies immediately, no restart needed.'
      },
      forceAssetDownload: {
        type: 'boolean',
        description:
          'Enforced identically by both routes that serve a stored asset — `GET /sites/:siteId/assets/:assetId/content` and the public `/_files/*` path: neither ever forces an inline-renderable extension (image types) to download, and both attach `Content-Disposition: attachment` to every other extension only when this is on (SVG still gets a sandboxing Content-Security-Policy either way). Read live on each request, unlike the rest of this card — flipping it applies immediately, no restart needed.'
      },
      trustProxy: {
        // -> Two real (non-null) types, so `oneOf` rather than `type: ['boolean', 'string']` -- AJV's
        //    strict mode (`allowUnionTypes`) only special-cases a type array of exactly one real type
        //    plus `'null'`, which `[X, 'null']` throughout this file's other properties relies on; two
        //    non-null types warns unless declared this way. `api/schemas/storage.ts`'s `sync.schedule`
        //    is the existing precedent for the identical shape (string-or-boolean).
        oneOf: [{ type: 'boolean' }, { type: 'string' }],
        description:
          '`false` trusts nothing (the default); a comma-separated address/CIDR list (e.g. `10.0.0.0/8, 192.168.1.1`, or the named ranges `loopback`/`linklocal`/`uniquelocal`) trusts `X-Forwarded-*` headers only when the request arrived from one of those addresses -- this is the setting a reverse-proxy deployment should use. `true` also validates, but trusts every request unconditionally: it makes `req.ip`, and therefore the IP-keyed auth rate limiter, controllable by the client, and lets any request steer which site it resolves against via `X-Forwarded-Host`. Use the address/CIDR form instead.'
      },
      insecureCookieRiskAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description:
          "Read-only runtime diagnostic, not a stored setting -- ignored if sent back in a PUT. Set the moment a request showed `X-Forwarded-Proto: https` arriving while Trust Proxy is off and this instance did not itself terminate TLS, i.e. `request.protocol` cannot see the header in that case. The session cookie itself no longer depends on this detection (it is unconditionally `Secure`/`SameSite=Lax`/`__Host-`-prefixed as of task 2109), but this instance's own belief about the connection's scheme is still wrong whenever the flag is set, which still misdirects the login/SSO callback URL `api/auth/provider.ts`'s `callbackUrl()` builds off `request.protocol`, and the sitemap/robots URLs `controllers/seo.ts` builds the same way. Null if that has not happened since this instance started. Clears itself only on a restart, once Trust Proxy has been turned on."
      },
      uploadMaxFileSize: {
        type: 'integer',
        minimum: 1,
        description:
          'Bytes. Enforced as the request body size limit on `POST /sites/:siteId/assets`.'
      },
      uploadScanSVG: {
        type: 'boolean',
        description:
          'Whether an uploaded SVG is run through a structure-and-shapes-only tag/attribute allowlist before being stored, stripping `<script>`, event-handler attributes, `foreignObject` and SMIL animation. Enforced on `POST /sites/:siteId/assets` and on a site image upload (logo, favicon, login background). Read live at upload time, unlike the rest of this card.'
      },
      authRateLimitEnabled: {
        type: 'boolean',
        description:
          'Whether the authentication endpoints — signing in, second factors, password changes from the login screen, passkey ceremonies and page unlocks — refuse a client that has attempted too often. Counted per client address, in the database, so the limit holds across instances.'
      },
      authRateLimitMax: {
        type: 'integer',
        minimum: 1,
        description: 'Attempts allowed within the window. The one that exceeds it earns the ban.'
      },
      authRateLimitWindow: {
        type: 'string',
        maxLength: 16,
        description: 'How long attempts are counted over, as a duration — e.g. `5m`, `2h`, `1d`.'
      },
      authRateLimitBan: {
        type: 'string',
        maxLength: 16,
        description:
          'How long a client is refused for once it goes over, as a duration — e.g. `15m`, `1h`. Attempts made while banned do not extend it.'
      },
      apiRateLimitEnabled: {
        type: 'boolean',
        description:
          'Whether any request under `/_api` — not just the authentication endpoints above — refuses a client that has made too many. Counted per API key, per signed-in user, or per client address, in the database, so the limit holds across instances.'
      },
      apiRateLimitMax: {
        type: 'integer',
        minimum: 1,
        description: 'Requests allowed within the window. The one that exceeds it earns the ban.'
      },
      apiRateLimitWindow: {
        type: 'string',
        maxLength: 16,
        description: 'How long requests are counted over, as a duration — e.g. `5m`, `2h`, `1d`.'
      },
      apiRateLimitBan: {
        type: 'string',
        maxLength: 16,
        description:
          'How long a client is refused for once it goes over, as a duration — e.g. `15m`, `1h`. Requests made while banned do not extend it.'
      }
    }
  })
}
