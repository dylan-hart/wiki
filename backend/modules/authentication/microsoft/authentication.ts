import { OidcPreset } from '../oidc/preset.ts'

/**
 * Microsoft (Azure AD / Entra ID)
 *
 * The v2.0 endpoint publishes standard OIDC discovery per tenant at
 * `https://login.microsoftonline.com/{tenantId}/v2.0/.well-known/openid-configuration` — `tenantId`
 * is a directory (tenant) ID or domain, or `common` for a multi-tenant app that accepts any Microsoft
 * account. `common` is the default here because that is the app registration most admins start from.
 *
 * 2.5.x's `microsoft/authentication.js` used `passport-microsoft` against hardcoded v2.0 endpoints
 * instead of discovery, presumably because at the time this fork's generic `OidcAuthentication` (or
 * anything like it) didn't exist yet to build on. Going through discovery here is a deliberate,
 * better-than-parity improvement over that: Microsoft's signing keys and endpoints are read from the
 * tenant's own metadata rather than pinned in this module, so a rotation on their side is followed
 * automatically instead of requiring a code change here.
 */
export default class MicrosoftAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => `https://login.microsoftonline.com/${c.tenantId || 'common'}/v2.0`
    })
  }
}
