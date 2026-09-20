import { OidcPreset } from '../oidc/preset.ts'

export default class KeycloakAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => `${String(c.baseUrl || '').replace(/\/$/, '')}/realms/${c.realm || ''}`
    })
  }
}
