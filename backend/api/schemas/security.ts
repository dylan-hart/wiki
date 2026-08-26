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
          'When on (the default), a group/site login/logout redirect and the `?redirect=` query parameter on a provider login must name a path on this wiki; an absolute URL to another host is refused. Turning it off additionally permits a complete `https?://` URL. Read live on each request via `helpers/redirectTarget.ts#absoluteRedirectsAllowed()`, unlike most of this card — flipping it applies immediately, no restart needed.'
      },
      forceAssetDownload: {
        type: 'boolean',
        description:
          'Enforced identically by both routes that serve a stored asset — `GET /sites/:siteId/assets/:assetId/content` and the public `/_files/*` path: neither ever forces an inline-renderable extension (image types) to download, and both attach `Content-Disposition: attachment` to every other extension only when this is on. Read live on each request, unlike the rest of this card — flipping it applies immediately, no restart needed.'
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
          'Read-only runtime diagnostic, not a stored setting -- ignored if sent back in a PUT. Set the moment a request showed `X-Forwarded-Proto: https` arriving while Trust Proxy is off and this instance did not itself terminate TLS: the session cookie that response set came out without `Secure`, because `request.protocol` can never see the header in that case. Null if that has not happened since this instance started. Clears itself only on a restart, once Trust Proxy has been turned on.'
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
          'Enforced: an uploaded `.svg` file is run through an allowlist sanitizer before it is stored, stripping `<script>`, event-handler attributes and anything else capable of executing. Read live at upload time, unlike the rest of this card.'
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
