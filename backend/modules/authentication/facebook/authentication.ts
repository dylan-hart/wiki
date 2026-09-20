import OAuth2Authentication from '../oauth2/authentication.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { ProviderProfile } from '../../../models/authentication.ts'

function buildFacebookConfig(conf: Record<string, any>): Record<string, any> {
  return {
    ...conf,
    // -> Facebook does not version the OAuth dialog independently of the Graph API, so both endpoints
    //    carry the same version prefix.
    authorizationURL: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenURL: 'https://graph.facebook.com/v19.0/oauth/access_token',
    // -> `fields=` is mandatory: a bare `/me` returns only `id` and `name`, never `email`.
    userInfoURL: 'https://graph.facebook.com/me?fields=id,name,email',
    // -> The only two permissions every app is granted automatically, with no Meta App Review.
    scope: 'email public_profile',
    userIdClaim: 'id',
    emailClaim: 'email',
    displayNameClaim: 'name'
  }
}

/**
 * Plain OAuth2 (Graph API), not OIDC: Facebook publishes no discovery document and issues no ID
 * token, only an access token exchanged for a `/me` call. Facebook also has no organization or
 * workspace equivalent to restrict login to, so unlike `discord` there is no `profile()` override.
 */
export default class FacebookAuthentication extends OAuth2Authentication {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, buildFacebookConfig(conf))
  }

  /**
   * `/me` carries no separated name halves, only `name`, so the split is the only source there is.
   * `fillNameHalves` leaves alone any half the base mapping did establish from a configured claim.
   * The split belongs here and not in `oauth2/authentication.ts`, where it would fire for every
   * plain-OAuth2 strategy, including ones whose provider reports real halves.
   */
  protected override mapProfile(info: Record<string, any>): ProviderProfile {
    const profile = super.mapProfile(info)
    return { ...profile, ...fillNameHalves(profile.name, profile) }
  }
}
