import { OidcPreset } from '../oidc/preset.ts'

/**
 * Okta's org authorization server is the issuer itself: the admin-supplied org URL is both what
 * discovery is fetched from and what `openid-client` checks the ID token's `iss` claim against. The
 * trailing slash is trimmed so either spelling of that URL templates to the same issuer.
 */
export default class OktaAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => String(c.orgUrl || '').replace(/\/$/, '')
    })
  }
}
