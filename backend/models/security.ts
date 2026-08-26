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
 * Security model
 *
 * The admin area's security view, which is exactly the `security` settings blob. Most of it is read
 * when the HTTP server starts — see the `Security` section of `index.ts` — so saving here takes
 * effect on the next restart.
 */
class Security {
  /**
   * Runtime diagnostic, not a stored setting: the moment (if ever, since this process started) a
   * request showed the classic reverse-proxy cookie misconfiguration (upstream discussion #6866,
   * task 833) -- the proxy says the original connection was HTTPS (`X-Forwarded-Proto: https`),
   * but this instance neither trusts that header (`trustProxy` is off) nor terminated TLS itself.
   * `request.protocol` can only ever reflect the raw, plaintext connection in that case, so the
   * `secure: 'auto'` session cookie (see the `Sessions` section of `index.ts`) resolves to
   * `false` even though every browser in front of the proxy is really talking HTTPS. Reset only by
   * a restart -- it describes how the process was started, not something that self-heals while it
   * keeps running the same way.
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
        return 'The hostname whitelist mode needs at least one hostname.'
      }
    }

    if (merged.enforceCsp) {
      let cspDirectives: Record<string, string[]>
      try {
        cspDirectives = parseCspDirectives(merged.cspDirectives ?? '')
      } catch (err: any) {
        return err.message
      }
      if (Object.keys(cspDirectives).length < 1) {
        return 'Enforcing a Content-Security-Policy needs at least one directive.'
      }
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
