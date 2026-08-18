import { OidcPreset } from '../oidc/preset.ts'

/**
 * Okta
 *
 * Okta's org authorization server is the issuer itself — an admin supplies the org URL (2.5.x called
 * this field "Audience" / "Org URL", e.g. `https://your-org.okta.com`), and that URL is both what
 * discovery is fetched from and what `openid-client` checks the ID token's `iss` claim against. A
 * trailing slash is trimmed so `https://your-org.okta.com/` and `https://your-org.okta.com` template
 * to the same issuer either way.
 */
export default class OktaAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => String(c.orgUrl || '').replace(/\/$/, '')
    })
  }
}
