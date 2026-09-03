import proxyAddr from '@fastify/proxy-addr'
import { CORS_MODES, parseCspDirectives } from '../helpers/security.ts'

/** Fields stored in the `security` settings blob. */
export const SECURITY_FIELDS = [
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
  'uploadScanSVG'
] as const

/** A duration as the admin area writes it: `30m`, `14d`, `1y`. */
const DURATION_PATTERN = /^\d+[smhdwy]$/

/**
 * Validate a trusted-proxy specification exactly the way it will actually be parsed at request time:
 * `getTrustProxyFn` in the vendored `fastify/lib/request.js` splits a string `trustProxy` on commas,
 * trims each entry, and hands the array to `@fastify/proxy-addr`'s own `compile()` -- the function
 * that throws on anything it cannot resolve to an address, a CIDR range, or one of its three named
 * ranges (`loopback`, `linklocal`, `uniquelocal`). Round-tripping through the same function here,
 * rather than a hand-written address/CIDR regex, is what keeps "accepted by the admin form" and
 * "trusted at request time" from ever drifting apart -- and it means a trailing comma or blank entry
 * (`'10.0.0.0/8,'` splits to `['10.0.0.0/8', '']`) is rejected here exactly as it would silently
 * become an untrusted-everything spec if it reached Fastify unvalidated.
 *
 * Exported so `security.test.ts` can assert against what will actually be accepted at runtime.
 *
 * @returns The reason it is invalid, or null when it is fine
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
 * Security model
 *
 * The admin area's security view, which is exactly the `security` settings blob. Most of it is read
 * when the HTTP server starts — see the `Security` section of `index.ts` — so saving here takes
 * effect on the next restart.
 */
class Security {
  /**
   * Runtime diagnostic, not a stored setting: the moment (if ever, since this process started) a
   * request showed the classic reverse-proxy misconfiguration (upstream discussion #6866, task
   * 833) -- the proxy says the original connection was HTTPS (`X-Forwarded-Proto: https`), but
   * this instance neither trusts that header (`trustProxy` is off) nor terminated TLS itself, so
   * `request.protocol` can only ever reflect the raw, plaintext connection.
   *
   * Originally this meant the session cookie itself came out insecure (`secure: 'auto'` resolving
   * `false`). As of task 2109 that is no longer true: the session cookie's `Secure`, `SameSite` and
   * `__Host-` name are all pinned unconditionally in `index.ts`'s `fastifySession` registration, so
   * this misdetection can no longer weaken it. What it still breaks is everything else that reads
   * `request.protocol` to decide what scheme it is talking: `api/auth/provider.ts#callbackUrl()`
   * builds the OAuth/SAML return URL from it (wrong scheme there fails the whole federated login,
   * not just the cookie), and `controllers/seo.ts` builds the sitemap/robots URLs the same way. The
   * field name and trigger stay as they are -- same underlying misconfiguration, same fix (turn on
   * Trust Proxy) -- but the risk it warns about is this broader one now, not a weakened cookie.
   * Reset only by a restart -- it describes how the process was started, not something that
   * self-heals while it keeps running the same way.
   */
  private insecureCookieRiskAt: string | null = null

  /**
   * Record one request's evidence for the diagnostic above. Called from the `onRequest` hook in
   * `index.ts` for every request -- deliberately cheap (header lookups only, no I/O) since it runs
   * on the hot path.
   */
  observeRequest(headers: Record<string, string | string[] | undefined>, protocol: string): void {
    if (WIKI.config.security?.trustProxy || protocol === 'https') {
      // -> Either the header is trusted (so `request.protocol` already reflects it) or this
      //    instance terminated TLS itself (so the cookie is secure regardless of the header) --
      //    neither is the misconfiguration this is watching for.
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

  /**
   * When the diagnostic above last fired, or null if it never has this process.
   */
  getInsecureCookieRiskAt(): string | null {
    return this.insecureCookieRiskAt
  }

  /**
   * The security configuration as the admin area expects it
   */
  getConfig(): Record<string, any> {
    const security = WIKI.config.security ?? {}
    const config: Record<string, any> = {}
    for (const field of SECURITY_FIELDS) {
      config[field] = security[field]
    }
    return config
  }

  /**
   * Keep only the fields this model owns, dropping anything else a client sends
   */
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
   * Check a patch against the settings it will end up merged with.
   *
   * Merged rather than in isolation, because these fields constrain each other: turning CSP on with
   * no directives, or picking the hostname whitelist mode without hostnames, would store a setting
   * that quietly does nothing.
   *
   * @returns The reason it is invalid, or null when it is fine
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

    // -> Parsed (and its directive names validated) regardless of `enforceCsp`: a typo'd or invented
    //    directive stored while enforcement is off would otherwise resurface, unvalidated, the
    //    moment enforcement is later switched on.
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

    // -> `trustProxy` accepts a boolean (trust every/no peer, unchanged legacy behavior) or a
    //    comma-separated address/CIDR list -- the form `index.ts` passes straight through to
    //    Fastify's own `trustProxy` option, whose vendored `request.js` already refuses to read
    //    `X-Forwarded-Host`/`-For`/`-Proto` from a peer address the list doesn't cover, falling
    //    back to the raw socket's own `Host` header instead. That is what closes the tenancy-
    //    isolation gap where any client could steer `req.hostname` (and therefore site
    //    resolution) by sending its own `X-Forwarded-Host` while the setting was a bare `true` --
    //    see `docs/audit-2026-08-24/security/13-tenancy-isolation.md` §6. Validated by
    //    {@link validateTrustProxySpec}, the same comma-splitting Fastify's own `getTrustProxyFn`
    //    does before handing a string `trustProxy` option to `proxyAddr.compile`
    //    (`fastify/lib/request.js`) -- round-tripping through the identical package and shape this
    //    ultimately gets passed to verbatim (`index.ts`'s `trustProxy:
    //    WIKI.config.security.trustProxy`) is what makes "accepted here" mean "accepted there".
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

  /**
   * Save a validated patch.
   *
   * @returns Whether the settings were saved
   */
  async updateConfig(patch: Record<string, any>): Promise<boolean> {
    const previousSecurity = WIKI.config.security
    WIKI.config.security = { ...previousSecurity, ...patch }

    if (!(await WIKI.configSvc.saveToDb(['security']))) {
      WIKI.config.security = previousSecurity
      return false
    }
    return true
  }
}

export const security = new Security()
