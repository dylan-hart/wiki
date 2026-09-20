import { OidcPreset } from '../oidc/preset.ts'

/** `domain` is the bare tenant domain (`something.auth0.com`), not a URL. */
export default class Auth0Authentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => `https://${c.domain}/`
    })
  }
}
