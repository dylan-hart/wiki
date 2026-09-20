import OidcAuthentication from './authentication.ts'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/**
 * `issuer` is a function rather than a string because some providers derive it from another
 * admin-supplied value — Auth0's is `https://{domain}/`, built from the tenant domain the admin
 * enters — while others (Slack, Twitch) can fix it outright.
 *
 * Every other field is optional and, when set, overrides whatever the admin's own config carries for
 * that key: a preset exists specifically to stop the admin from having to know a scope string or a
 * claim name that is the same for every tenant of that provider.
 */
export interface OidcPresetTemplate {
  issuer: (conf: Record<string, any>) => string
  scopes?: string
  emailClaim?: string
  displayNameClaim?: string
  useDiscovery?: boolean
  /**
   * Authorization-request parameters a provider needs beyond the generic set, merged onto the
   * authorization URL as-is — Twitch wants a static `claims` parameter asking for email even under
   * PKCE. The function form is for a preset whose extra parameter depends on what the admin
   * configured, such as Slack's optional `team` restriction: returning `undefined` there means
   * "nothing extra", not an empty or `"undefined"` query param.
   */
  extraAuthParams?:
    | Record<string, string>
    | ((conf: Record<string, any>) => Record<string, string> | undefined)
}

/** Exported rather than folded into the constructor so a preset's template can be asserted. */
export function buildOidcConfig(
  template: OidcPresetTemplate,
  conf: Record<string, any>
): Record<string, any> {
  return {
    ...conf,
    issuer: template.issuer(conf),
    scopes: template.scopes ?? conf.scopes,
    emailClaim: template.emailClaim ?? conf.emailClaim,
    displayNameClaim: template.displayNameClaim ?? conf.displayNameClaim,
    useDiscovery: template.useDiscovery ?? conf.useDiscovery,
    extraAuthParams:
      typeof template.extraAuthParams === 'function'
        ? template.extraAuthParams(conf)
        : (template.extraAuthParams ?? conf.extraAuthParams)
  }
}

/**
 * Wraps one `OidcAuthentication`, built once from `buildOidcConfig`, and forwards every call to it,
 * so the protocol work (discovery, PKCE, ID token verification, userinfo merge) stays owned by that
 * one module rather than being copied into each branded preset.
 */
export class OidcPreset {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  private inner: OidcAuthentication

  constructor(strategyId: string, conf: Record<string, any>, template: OidcPresetTemplate) {
    this.strategyId = strategyId
    this.conf = conf
    this.inner = new OidcAuthentication(strategyId, buildOidcConfig(template, conf))
  }

  authorizationUrl(flow: AuthFlow): Promise<string> {
    return this.inner.authorizationUrl(flow)
  }

  profile(flow: AuthFlowCallback): Promise<ProviderProfile> {
    return this.inner.profile(flow)
  }

  logoutUrl(): string | null {
    return this.inner.logoutUrl()
  }
}
