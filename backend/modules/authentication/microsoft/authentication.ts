import { OidcPreset } from '../oidc/preset.ts'

/**
 * Microsoft (Azure AD / Entra ID)
 *
 * The v2.0 endpoint publishes standard OIDC discovery per tenant at
 * `https://login.microsoftonline.com/{tenantId}/v2.0/.well-known/openid-configuration` — `tenantId`
 * is a directory (tenant) ID or verified domain from the app registration.
 *
 * `tenantId` is required, with no `common` fallback: `openid-client` special-cases the
 * `login.microsoftonline.com` host specifically, replacing the issuer it validates an ID token
 * against with one derived from that token's own `tid` claim rather than the tenant this preset was
 * configured with -- so with `tenantId` left as `common`, issuer validation passes for a token from
 * *any* Microsoft tenant, and an administrator of any one of them can freely set the `email` claim
 * their own directory reports. Returning an empty issuer here (rather than defaulting to `common`)
 * makes an unconfigured tenant fail the same way a missing `issuer` already does in the generic
 * module -- `ERR_STRATEGY_MISCONFIGURED` from `OidcAuthentication#configuration()` -- with no
 * separate check needed on this side. (OpenProject #2112)
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
