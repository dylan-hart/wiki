import { OidcPreset } from '../oidc/preset.ts'

/**
 * Azure AD / Entra ID. `tenantId` is a directory (tenant) ID or verified domain from the app
 * registration, and the v2.0 endpoint publishes standard OIDC discovery per tenant, so signing keys
 * and endpoints follow the tenant's own metadata rather than being pinned here.
 *
 * `tenantId` is required, with no `common` fallback: `openid-client` special-cases the
 * `login.microsoftonline.com` host, validating an ID token against an issuer derived from that
 * token's own `tid` claim rather than the configured tenant -- so under `common`, a token from
 * *any* Microsoft tenant passes issuer validation, and an administrator of any one of them controls
 * the `email` claim their directory reports. An empty issuer makes an unconfigured tenant fail as
 * `ERR_STRATEGY_MISCONFIGURED` in `OidcAuthentication#configuration()`, needing no check here.
 */
export default class MicrosoftAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => (c.tenantId ? `https://login.microsoftonline.com/${c.tenantId}/v2.0` : '')
    })
  }
}
