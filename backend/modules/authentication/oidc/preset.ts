import OidcAuthentication from './authentication.ts'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/**
 * What a branded preset fixes about the generic OIDC module, so its `authentication.ts` doesn't have
 * to re-hardcode `client.discovery`/`buildAuthorizationUrl`/`authorizationCodeGrant` the way
 * `google/authentication.ts` does. `issuer` is a function rather than a string because some providers
 * derive it from another admin-supplied value — Auth0's issuer is `https://{domain}/`, built from the
 * tenant domain the admin enters — while others (Slack, Discord) can fix it outright.
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
   * Static authorization-request parameters a provider needs beyond the generic set, forwarded to
   * `OidcAuthentication`'s `extraAuthParams` and merged onto the authorization URL as-is. Twitch is
   * the reason this exists: it wants a `claims` parameter asking for email even under PKCE.
   */
  extraAuthParams?: Record<string, string>
}

/**
 * Merge a preset's fixed template over the admin's config, producing what the generic OIDC module
 * actually needs. Exported standalone (rather than folded into the constructor below) so a preset's
 * template can be asserted against directly, with no network involved — everything downstream of this
 * merge is `OidcAuthentication` itself, already covered by its own behaviour.
 */
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
    extraAuthParams: template.extraAuthParams ?? conf.extraAuthParams
  }
}

/**
 * Base class for a branded OIDC preset.
 *
 * A preset's whole `authentication.ts` is meant to be its template plus this:
 *
 *   export default class Auth0Authentication extends OidcPreset {
 *     constructor(strategyId: string, conf: Record<string, any>) {
 *       super(strategyId, conf, { issuer: (c) => `https://${c.domain}/` })
 *     }
 *   }
 *
 * It wraps one `OidcAuthentication`, built once from `buildOidcConfig`, and forwards every call to
 * it — the protocol work (discovery, PKCE, ID token verification, userinfo merge) stays owned by that
 * one module, never copied.
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
