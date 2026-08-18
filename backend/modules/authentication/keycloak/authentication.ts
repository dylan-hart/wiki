import { OidcPreset } from '../oidc/preset.ts'

/**
 * Keycloak
 *
 * Unlike every other preset in this directory, Keycloak is not a hosted service with one fixed
 * account of endpoints per admin — it is self-hosted, so both pieces of the issuer are the admin's
 * own: the base URL of their Keycloak install, and which realm on it this wiki signs into. The issuer
 * a realm publishes discovery under is `{baseUrl}/realms/{realm}`; a trailing slash on `baseUrl` is
 * trimmed so it templates the same either way.
 */
export default class KeycloakAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => `${String(c.baseUrl || '').replace(/\/$/, '')}/realms/${c.realm || ''}`
    })
  }
}
