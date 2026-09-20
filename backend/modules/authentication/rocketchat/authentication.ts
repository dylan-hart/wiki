import OAuth2Authentication from '../oauth2/authentication.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { ProviderProfile } from '../../../models/authentication.ts'

/**
 * Rocket.Chat is self-hosted, so there is no fixed host to fix endpoints against: every one is
 * templated off the admin's own `serverUrl`, with a trailing slash trimmed so the template works
 * identically whether the admin entered one or not.
 */
function buildRocketChatConfig(conf: Record<string, any>): Record<string, any> {
  const serverUrl = String(conf.serverUrl || '').replace(/\/$/, '')
  return {
    ...conf,
    // -> Left undefined (not a hostless relative URL) when `serverUrl` is unset, so the base class's
    //    `assertConfigured()` refuses with `ERR_STRATEGY_MISCONFIGURED` rather than letting a URL
    //    with no host fail some other, less legible way later.
    authorizationURL: serverUrl ? `${serverUrl}/oauth/authorize` : undefined,
    tokenURL: serverUrl ? `${serverUrl}/oauth/token` : undefined,
    userInfoURL: serverUrl ? `${serverUrl}/api/v1/me` : undefined,
    // -> `/api/v1/me`'s user id field; base `mapProfile()` would otherwise look for `id`.
    userIdClaim: '_id',
    displayNameClaim: 'name'
    // -> No `emailClaim`/`emailVerifiedClaim`: both are nested under an `emails` array, out of reach
    //    of a claim-name lookup, so `mapProfile()` below reads `emails[0]` directly instead.
  }
}

/**
 * Rocket.Chat's "OAuth Apps" feature is plain OAuth2, not OpenID Connect — no discovery document,
 * JWKS or ID token anywhere in that surface — so this is a preset over the generic `oauth2` module
 * rather than `OidcPreset`.
 */
export default class RocketChatAuthentication extends OAuth2Authentication {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, buildRocketChatConfig(conf))
  }

  /**
   * `/api/v1/me` reports email inside an `emails` array and the name as one combined string, neither
   * of which the base class's flat claim-name lookup can express. The name split stays on this
   * preset rather than the base `oauth2` class, where it would pre-empt every provider that does
   * report real name claims.
   */
  protected override mapProfile(info: Record<string, any>): ProviderProfile {
    const emails = Array.isArray(info.emails) ? info.emails : []
    const primaryEmail = emails[0]
    const email =
      primaryEmail && typeof primaryEmail.address === 'string' ? primaryEmail.address : ''
    if (!email) {
      throw new Error('ERR_NO_EMAIL_FROM_PROVIDER')
    }
    if (primaryEmail.verified === false && this.conf.allowUnverifiedEmail !== true) {
      throw new Error('ERR_EMAIL_NOT_VERIFIED')
    }

    const profile = super.mapProfile({ ...info, email })
    return { ...profile, email, ...fillNameHalves(profile.name, profile) }
  }
}
