import proxyAddr from '@fastify/proxy-addr'
import { CORS_MODES, parseCspDirectives } from '../helpers/security.ts'

export const SECURITY_FIELDS = [
  'allowPasskeys',
  'apiRateLimitBan',
  'apiRateLimitEnabled',
  'apiRateLimitMax',
  'apiRateLimitWindow',
  'authRateLimitBan',
  'authRateLimitEnabled',
  'authRateLimitMax',
  'authRateLimitWindow',
  'corsConfig',
  'corsMode',
  'cspDirectives',
  'disallowIframe',
  'disallowOpenRedirect',
  'enforceCsp',
  'enforceHsts',
  'enforceSameOriginReferrerPolicy',
  'forceAssetDownload',
  'hstsDuration',
  'trustProxy',
  'uploadMaxFileSize',
  'uploadMaxFilesPerBatch',
  'uploadScanSVG'
] as const

/**
 * Read live rather than cached: `updateConfig` swaps `CARDINAL.config.security` in place. A blob
 * saved before the field existed has no value and reads as allowed.
 */
export function passkeysAllowed(): boolean {
  return CARDINAL.config.security?.allowPasskeys !== false
}

const DURATION_PATTERN = /^\d+[smhdwy]$/

/**
 * Round-trips through the same comma-split and `proxyAddr.compile()` that Fastify's own
 * `getTrustProxyFn` applies to a string `trustProxy` at request time, rather than a hand-written
 * address/CIDR regex, so "accepted by the admin form" cannot drift from "trusted at request time"
 * -- a trailing comma or blank entry (`'10.0.0.0/8,'`) included.
 */
export function validateTrustProxySpec(spec: string): string | null {
  try {
    proxyAddr.compile(spec.split(',').map((entry) => entry.trim()))
    return null
  } catch (err: any) {
    return `The trusted proxy list is invalid: ${err.message}`
  }
}

/**
 * Most of this blob is read once, while the HTTP server is being built (`core/http/security.ts`,
 * `core/http/session.ts`), so a save here only takes effect on the next restart.
 */
class Security {
  /**
   * Runtime diagnostic, not a stored setting: when this process last saw the classic reverse-proxy
   * misconfiguration -- the proxy reports the connection as HTTPS (`X-Forwarded-Proto: https`) but
   * this instance neither trusts that header (`trustProxy` off) nor terminated TLS itself, so
   * `request.protocol` can only reflect the plaintext connection. The session cookie fails closed
   * rather than downgrading (`core/http/session.ts`); the real damage is to anything deriving a
   * scheme from `request.protocol`, such as `api/auth/provider.ts#callbackUrl()`'s OAuth/SAML
   * return URL. Nothing clears it: it describes how the process was started.
   */
  private insecureCookieRiskAt: string | null = null

  /** On the hot path (every request's `onRequest` hook): header lookups only, no I/O. */
  observeRequest(headers: Record<string, string | string[] | undefined>, protocol: string): void {
    if (CARDINAL.config.security?.trustProxy || protocol === 'https') {
      return
    }
    const forwardedProto = headers['x-forwarded-proto']
    const firstProto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
      ?.split(',')[0]
      ?.trim()
      .toLowerCase()
    if (firstProto === 'https') {
      this.insecureCookieRiskAt = Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
    }
  }

  getInsecureCookieRiskAt(): string | null {
    return this.insecureCookieRiskAt
  }

  getConfig(): Record<string, any> {
    const security = CARDINAL.config.security ?? {}
    const config: Record<string, any> = {}
    for (const field of SECURITY_FIELDS) {
      config[field] = security[field]
    }
    return config
  }

  pickFields(body: Record<string, any>): Record<string, any> {
    const patch: Record<string, any> = {}
    for (const field of SECURITY_FIELDS) {
      if (body[field] !== undefined) {
        patch[field] = body[field]
      }
    }
    return patch
  }

  /**
   * Checked against the merged result rather than the patch in isolation, because these fields
   * constrain each other: CSP on with no directives, or the hostname whitelist mode without
   * hostnames, would store a setting that quietly does nothing.
   */
  validate(patch: Record<string, any>): string | null {
    const merged = { ...this.getConfig(), ...patch }

    if (!CORS_MODES.includes(merged.corsMode)) {
      return `"${merged.corsMode}" is not a valid CORS mode.`
    }
    if (merged.corsMode === 'REGEX') {
      try {
        new RegExp(merged.corsConfig ?? '')
      } catch (err: any) {
        return `The CORS regex pattern is invalid: ${err.message}`
      }
    }
    if (merged.corsMode === 'HOSTNAMES') {
      const hostnames = (merged.corsConfig ?? '')
        .split(/[\n,]/)
        .map((entry: string) => entry.trim())
        .filter(Boolean)
      if (hostnames.length < 1) {
        return 'The origin whitelist mode needs at least one origin, such as https://wiki.example.com.'
      }
    }

    // -> Parsed regardless of `enforceCsp`: a typo'd directive stored while enforcement is off
    //    would otherwise resurface, unvalidated, the moment enforcement is switched on.
    let cspDirectives: Record<string, string[]> = {}
    if (merged.cspDirectives) {
      try {
        cspDirectives = parseCspDirectives(merged.cspDirectives)
      } catch (err: any) {
        return err.message
      }
    }
    if (merged.enforceCsp && Object.keys(cspDirectives).length < 1) {
      return 'Enforcing a Content-Security-Policy needs at least one directive.'
    }

    if (merged.enforceHsts && !(merged.hstsDuration > 0)) {
      return 'Enforcing HSTS needs a duration greater than zero.'
    }

    if (merged.authRateLimitEnabled) {
      if (!(merged.authRateLimitMax > 0)) {
        return 'The attempt limit must be greater than zero.'
      }
      for (const [field, label] of [
        ['authRateLimitWindow', 'time window'],
        ['authRateLimitBan', 'ban duration']
      ] as const) {
        if (!DURATION_PATTERN.test(`${merged[field] ?? ''}`.trim())) {
          return `The ${label} must be a duration such as 30s, 15m, 2h or 1d.`
        }
      }
    }

    if (merged.apiRateLimitEnabled) {
      if (!(merged.apiRateLimitMax > 0)) {
        return 'The API request limit must be greater than zero.'
      }
      for (const [field, label] of [
        ['apiRateLimitWindow', 'time window'],
        ['apiRateLimitBan', 'ban duration']
      ] as const) {
        if (!DURATION_PATTERN.test(`${merged[field] ?? ''}`.trim())) {
          return `The ${label} must be a duration such as 30s, 15m, 2h or 1d.`
        }
      }
    }

    // -> A boolean (trust every/no peer) or a comma-separated address/CIDR list, passed straight
    //    through to Fastify's own `trustProxy` option. The list form closes the tenancy-isolation
    //    gap a bare `true` leaves open: Fastify reads `X-Forwarded-Host`/`-For`/`-Proto` only from
    //    a peer the list covers, so a client can no longer steer `req.hostname` -- and therefore
    //    site resolution -- with a header of its own.
    if (typeof merged.trustProxy === 'string' && merged.trustProxy.trim() !== '') {
      const err = validateTrustProxySpec(merged.trustProxy)
      if (err) {
        return err
      }
    } else if (
      typeof merged.trustProxy !== 'boolean' &&
      merged.trustProxy !== undefined &&
      merged.trustProxy !== ''
    ) {
      return '"trustProxy" must be a boolean, or a trusted-proxy address/CIDR list.'
    }

    return null
  }

  /** Expects a patch that has already been through {@link validate}. */
  async updateConfig(patch: Record<string, any>): Promise<boolean> {
    const previousSecurity = CARDINAL.config.security
    CARDINAL.config.security = { ...previousSecurity, ...patch }

    if (!(await CARDINAL.configSvc.saveToDb(['security']))) {
      CARDINAL.config.security = previousSecurity
      return false
    }
    return true
  }
}

export const security = new Security()
