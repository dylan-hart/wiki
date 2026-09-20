import { OidcPreset } from '../oidc/preset.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/**
 * Two things Twitch does differently from a standard OIDC provider:
 *
 *   - It requires `client_secret` on the token request even though the flow also uses PKCE. That
 *     needs nothing extra here: `client.Configuration` defaults to `client_secret_post` whenever a
 *     client secret is present, and one is always passed.
 *   - Its scopes carry no email; email reaches the ID token and userinfo response only via a
 *     `claims` request parameter (https://dev.twitch.tv/docs/authentication/getting-tokens-oidc/#claims-parameter).
 *     `buildAuthorizationUrl` forwards an unrecognised key onto the query string untouched, which is
 *     what `extraAuthParams` rides on.
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
   * Twitch's claim set carries no `given_name`/`family_name` at all, so an account name is a handle
   * and the split leaves it a mononym rather than inventing a surname. It stays on this preset rather
   * than `oidc/preset.ts`, where it would pre-empt the real name claims other presets read.
   */
  override async profile(flow: AuthFlowCallback): Promise<ProviderProfile> {
    const profile = await super.profile(flow)
    return { ...profile, ...fillNameHalves(profile.name, profile) }
  }
}
