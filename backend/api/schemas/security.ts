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
        description: 'Stored, but nothing redirects on user input yet.'
      },
      forceAssetDownload: {
        type: 'boolean',
        description:
          'Enforced: `GET /sites/:siteId/assets/:assetId/content` sends `Content-Disposition: attachment` for every file when this is on, non-image extensions otherwise. Read live on each request, unlike the rest of this card — flipping it applies immediately, no restart needed.'
      },
      trustProxy: {
        type: 'boolean',
        description: 'Whether to trust `X-Forwarded-*` headers.'
      },
      insecureCookieRiskAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description:
          "Read-only runtime diagnostic, not a stored setting -- ignored if sent back in a PUT. Set the moment a request showed `X-Forwarded-Proto: https` arriving while Trust Proxy is off and this instance did not itself terminate TLS, i.e. `request.protocol` cannot see the header in that case. The session cookie itself no longer depends on this detection (it is unconditionally `Secure`/`SameSite=Lax`/`__Host-`-prefixed as of task 2109), but this instance's own belief about the connection's scheme is still wrong whenever the flag is set, which still misdirects the login/SSO callback URL `api/authentication.ts`'s `callbackUrl()` builds off `request.protocol`, and the sitemap/robots URLs `controllers/seo.ts` builds the same way. Null if that has not happened since this instance started. Clears itself only on a restart, once Trust Proxy has been turned on."
      },
      uploadMaxFileSize: {
        type: 'integer',
        minimum: 1,
        description:
          'Bytes. Enforced as the request body size limit on `POST /sites/:siteId/assets`.'
      },
      uploadMaxFiles: {
        type: 'integer',
        minimum: 1,
        description:
          'Stored, but not enforced: an upload request is always exactly one file, so there is no batch to cap yet.'
      },
      uploadScanSVG: {
        type: 'boolean',
        description: 'Stored, but not enforced yet: nothing scans or sanitizes an uploaded SVG.'
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
