import { OidcPreset } from '../oidc/preset.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/**
 * Twitch
 *
 * Twitch's issuer is fixed — there is one Twitch, not a per-tenant deployment — so this preset needs
 * no admin-supplied domain/org/base-URL prop at all, just the client credentials.
 *
 * Two things Twitch does differently from a standard OIDC provider, both confirmed against
 * `openid-client`'s actual behaviour rather than assumed:
 *
 *   - It requires `client_secret` on the token request even though the flow also uses PKCE. This
 *     needs nothing extra here: `client.Configuration`'s default client-authentication method is
 *     `client_secret_post` whenever a client secret is present (see
 *     `openid-client`'s `Configuration` constructor), and this fork always passes one, so the secret
 *     is already sent on every token exchange this module makes — PKCE and the client secret are not
 *     alternatives here, both go out together.
 *   - Its default scopes carry no email; email is only added to the ID token and userinfo response
 *     via a `claims` request parameter (https://dev.twitch.tv/docs/authentication/getting-tokens-oidc/#claims-parameter).
 *     `buildAuthorizationUrl` takes a plain params object/`URLSearchParams`, so an unrecognised key
 *     is just forwarded onto the query string — `extraAuthParams` (plumbed through
 *     `oidc/preset.ts` → `oidc/authentication.ts`) is exactly that hook.
 */
export default class TwitchAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: () => 'https://id.twitch.tv/oauth2',
      scopes: 'openid',
      extraAuthParams: {
        claims: JSON.stringify({ id_token: { email: null }, userinfo: { email: null } })
      }
    })
  }

  /**
   * Twitch issues no name claims beyond `preferred_username` — its OIDC claim set is deliberately
   * minimal (id, `preferred_username`, `picture`, and `email` only via the `claims` parameter above),
   * with no `given_name`/`family_name` at all — so a Twitch account is a handle, and the split leaves
   * it as a mononym rather than inventing a surname out of it. `fillNameHalves` still guards the
   * claim-sourced case so this never overwrites a half something upstream did establish.
   *
   * An override here, not on `oidc/preset.ts`: the shared base is `#2640`'s and reaches five other
   * presets whose providers do report real halves.
   */
  override async profile(flow: AuthFlowCallback): Promise<ProviderProfile> {
    const profile = await super.profile(flow)
    return { ...profile, ...fillNameHalves(profile.name, profile) }
  }
}
