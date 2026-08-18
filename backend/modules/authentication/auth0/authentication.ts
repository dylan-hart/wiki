import { OidcPreset } from '../oidc/preset.ts'

/**
 * Auth0
 *
 * Auth0 is a hosted OpenID Connect provider, so this is that protocol with a per-tenant template: the
 * admin supplies only the tenant domain (e.g. `something.auth0.com`), and everything else the generic
 * module needs — the issuer, chief among them — is derived from it. Discovery then does the rest, the
 * same way it does for `oidc/authentication.ts`.
 */
export default class Auth0Authentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => `https://${c.domain}/`
    })
  }
}
