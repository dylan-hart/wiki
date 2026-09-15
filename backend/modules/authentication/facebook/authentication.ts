import OAuth2Authentication from '../oauth2/authentication.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { ProviderProfile } from '../../../models/authentication.ts'

/** Facebook's fixed Graph API endpoints, merged over whatever the admin config carries (only credentials). */
function buildFacebookConfig(conf: Record<string, any>): Record<string, any> {
  return {
    ...conf,
    // -> Graph API v19+; Facebook does not version its OAuth dialog/token endpoints independently
    //    of the Graph API itself, so both carry the same `/v19.0/` prefix.
    authorizationURL: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenURL: 'https://graph.facebook.com/v19.0/oauth/access_token',
    // -> `fields=id,name,email` is required -- unlike most providers' userinfo endpoints, a bare
    //    `/me` call returns only `id` and `name`; `email` has to be asked for explicitly per request.
    userInfoURL: 'https://graph.facebook.com/me?fields=id,name,email',
    // -> Both remain default-available scopes (no Meta App Review needed) as of Graph API v19 per
    //    current Meta developer docs (developers.facebook.com/docs/permissions/reference) --
    //    `email` and `public_profile` are the two permissions granted to every app automatically.
    //    App Review has tightened considerably for small/self-hosted apps in recent years, but that
    //    tightening applies to *other* permissions (e.g. `user_friends`, Business-asset scopes),
    //    not to this pair.
    scope: 'email public_profile',
    // -> Facebook's `/me` object has no `displayName`-style split; `name` is the one display string.
    userIdClaim: 'id',
    emailClaim: 'email',
    displayNameClaim: 'name'
  }
}

/**
 * Facebook
 *
 * Facebook speaks plain OAuth2 (Graph API), not OpenID Connect -- there is no
 * `.well-known/openid-configuration` discovery document and no ID token, only an access token
 * exchanged for a Graph API `/me` call. Same delegation shape as `discord/authentication.ts`: a thin
 * wrapper over `OAuth2Authentication` fixing every endpoint and claim name, since there is one
 * Facebook, not a per-tenant deployment. See `docs/audits/auth-provider-audit.md` for the
 * classification.
 *
 * Facebook has no guild/organization/workspace equivalent to restrict login to, so unlike
 * `discord/authentication.ts` and `slack`'s membership checks there is no analogous restriction prop
 * or `profile()` override needed here -- `mapProfile()` is the only override, for the same
 * single-display-string reason every mononym-shaped provider needs one (`github`, `discord`,
 * `slack`, `twitch`, `cas`).
 */
export default class FacebookAuthentication extends OAuth2Authentication {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, buildFacebookConfig(conf))
  }

  /**
   * The base mapping, plus the first/last split every single-string provider needs.
   *
   * Facebook's `/me` response carries no separated name halves -- only `name`, a single free-text
   * display string -- so the split is the only source there is. Applied through `fillNameHalves`
   * rather than unconditionally, matching `discord/authentication.ts#mapProfile`: a half the generic
   * `oauth2` mapping already established from a configured claim is never re-guessed. The override
   * lives here rather than in `oauth2/authentication.ts` deliberately -- a fallback in the base class
   * would fire for every plain-OAuth2 strategy, including ones whose provider reports real halves.
   */
  protected override mapProfile(info: Record<string, any>): ProviderProfile {
    const profile = super.mapProfile(info)
    return { ...profile, ...fillNameHalves(profile.name, profile) }
  }
}
