import OAuth2Authentication from '../oauth2/authentication.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { ProviderProfile } from '../../../models/authentication.ts'

/**
 * Rocket.Chat's own admin-configured endpoints, merged over whatever the admin config carries
 * (credentials + `serverUrl`). Unlike `discord`/`slack` there is no single hosted host — Rocket.Chat
 * is self-hosted, so every endpoint is templated off the admin's own `serverUrl`, the same shape
 * `keycloak/authentication.ts` uses for its issuer: a trailing slash is trimmed so the template works
 * identically whether the admin entered one or not.
 */
function buildRocketChatConfig(conf: Record<string, any>): Record<string, any> {
  const serverUrl = String(conf.serverUrl || '').replace(/\/$/, '')
  return {
    ...conf,
    // -> Left undefined (not a bogus relative URL) when `serverUrl` is unset, so the base class's own
    //    `assertConfigured()` truthiness check refuses with `ERR_STRATEGY_MISCONFIGURED` — the same
    //    outcome a missing `clientId`/`clientSecret` already gets — rather than building a URL with no
    //    host that fails some other, less legible way later.
    authorizationURL: serverUrl ? `${serverUrl}/oauth/authorize` : undefined,
    tokenURL: serverUrl ? `${serverUrl}/oauth/token` : undefined,
    userInfoURL: serverUrl ? `${serverUrl}/api/v1/me` : undefined,
    // -> `/api/v1/me`'s user id field; base `mapProfile()` would otherwise look for `id`.
    userIdClaim: '_id',
    displayNameClaim: 'name'
    // -> No `emailClaim`/`emailVerifiedClaim` here: Rocket.Chat nests both under an `emails` array
    //    rather than reporting either as a flat claim, so the base class's claim-name lookup can't
    //    reach them at all. `mapProfile()` below reads `emails[0]` directly instead.
  }
}

/**
 * Rocket.Chat
 *
 * Rocket.Chat's "OAuth Apps" feature (Administration > OAuth Apps) is plain OAuth2, not OpenID
 * Connect — confirmed against current Rocket.Chat docs rather than assumed: the OAuth App resource
 * itself is documented as `_id`/`name`/`active`/`clientId`/`clientSecret`/`redirectUri` plus the
 * `Authorization URL`/`Access Token URL` pair
 * (`developer.rocket.chat/apidocs/get-oauth-app`), with no discovery document, JWKS or ID token
 * mentioned anywhere in that surface — unlike Slack's "Sign in with Slack", there is nothing here to
 * reclassify. So, like `discord/authentication.ts`, this is a thin preset over the generic `oauth2`
 * module rather than `OidcPreset` — the same delegation shape `keycloak/authentication.ts` uses for
 * its own self-hosted `OidcPreset` case, just for the OAuth2-only side of the module family.
 *
 * `/api/v1/me` (Rocket.Chat's standard "current user" REST endpoint, confirmed still serving
 * `_id`/`name`/`username`/`emails` today) is both the identity endpoint 2.5.x's own `rocketchat`
 * module read and the response this class maps: `emails` is an array of `{ address, verified }`
 * rather than a flat `email`/`email_verified` pair, which is the one shape the generic `oauth2`
 * module's claim-name lookup cannot express (it reads one field by name, not an array element) — so
 * `mapProfile()` is overridden here the same way `discord/authentication.ts` overrides it for its own
 * provider-specific reason, pulling `emails[0].address`/`emails[0].verified` before deferring to the
 * base class for everything else `/api/v1/me` reports as a flat claim (`_id`, `name`).
 *
 * Rocket.Chat OAuth Apps are registered per self-hosted workspace already — unlike Discord's
 * cross-guild `identify` scope, there is no separate "which of several communities on this one
 * provider" restriction to express, so this preset needs no membership-restriction analog.
 */
export default class RocketChatAuthentication extends OAuth2Authentication {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, buildRocketChatConfig(conf))
  }

  /**
   * The base mapping (id/display-name/groups) plus Rocket.Chat's own two overrides: pulling email out
   * of `emails[0]` instead of a flat claim, and the first/last split every single-string-name
   * provider needs (`/api/v1/me` reports one `name` string, no separated halves) via `fillNameHalves`
   * — applied only where a half isn't already known, same as `discord/authentication.ts`, and kept on
   * this preset rather than the base `oauth2` class for the same blast-radius reason: a fallback
   * there would fire for every plain-OAuth2 strategy, including one whose provider does report real
   * name claims.
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
