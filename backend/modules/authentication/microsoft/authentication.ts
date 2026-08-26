import { OidcPreset } from '../oidc/preset.ts'

/**
 * Microsoft (Azure AD / Entra ID)
 *
 * The v2.0 endpoint publishes standard OIDC discovery per tenant at
 * `https://login.microsoftonline.com/{tenantId}/v2.0/.well-known/openid-configuration` — `tenantId`
 * is a directory (tenant) ID or verified domain from the app registration's Overview page.
 *
 * There is deliberately no default (and no fallback to Microsoft's `common` multi-tenant endpoint):
 * `openid-client` special-cases `login.microsoftonline.com` and, for that host, replaces the issuer it
 * expects with one derived from the token's own `tid` claim rather than the tenant that was
 * configured — so an ID token from *any* Microsoft tenant passes issuer validation regardless of which
 * tenant an admin thinks they restricted sign-in to, and Entra's `email` claim is a mutable directory
 * attribute a tenant administrator controls. Leaving `tenantId` blank templates the issuer to an empty
 * string, which `OidcAuthentication#configuration()` already refuses to build a configuration from
 * (`ERR_STRATEGY_MISCONFIGURED`) — the same refusal a missing issuer gets for every other preset.
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
      issuer: (c) => (c.tenantId ? `https://login.microsoftonline.com/${c.tenantId}/v2.0` : '')
    })
  }
}
