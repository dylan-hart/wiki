import OAuth2Authentication from '../oauth2/authentication.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/** Discord's fixed endpoints, merged over whatever the admin config carries (only credentials + guildId). */
function buildDiscordConfig(conf: Record<string, any>): Record<string, any> {
  return {
    ...conf,
    authorizationURL: 'https://discord.com/api/oauth2/authorize',
    tokenURL: 'https://discord.com/api/oauth2/token',
    userInfoURL: 'https://discord.com/api/users/@me',
    // -> `guilds` is a separate, narrower scope than `identify`/`email` and is Discord's own
    //    least-privilege gate on `/users/@me/guilds`: only requested when a guildId restriction is
    //    actually configured, mirroring how github/authentication.ts only asks for `read:org` when
    //    `allowedOrganization` is set.
    scope: conf.guildId ? 'identify email guilds' : 'identify email',
    // -> Discord's user object has no `displayName`; `username` (unlike the newer `global_name`,
    //    which is null for a user who never set one) is always present.
    userIdClaim: 'id',
    emailClaim: 'email',
    displayNameClaim: 'username',
    // -> Discord's user object carries its own sibling `verified` boolean alongside `email` --
    //    naming it here is what makes `OAuth2Authentication.mapProfile()` actually read it, rather
    //    than fetching it and discarding it as before.
    emailVerifiedClaim: 'verified'
  }
}

/**
 * Discord
 *
 * Discord speaks plain OAuth2, not OpenID Connect — confirmed live during this task rather than
 * assumed: `discord.com/.well-known/openid-configuration` does answer 200, but its
 * `response_types_supported` lists only `code`/`token`, no `id_token`, and Discord's own current docs
 * (`docs.discord.com/developers/topics/oauth2`) describe the flow as RFC 6749 with no OIDC extension.
 * A discovery document alone isn't OIDC compliance; a verifiable ID token is, and Discord issues
 * none — see docs/auth-provider-audit.md. So this is a thin wrapper over the generic `oauth2` module,
 * the same delegation shape the OIDC presets use over `OidcAuthentication`, fixing every endpoint and
 * the claim names since there is one Discord, not a per-tenant deployment.
 *
 * The one thing a generic OAuth2 config can't express is Discord's optional guild (server) membership
 * restriction — the redirect-based analogue of 2.5.x's guild check and this fork's
 * `github/authentication.ts` `allowedOrganization` pattern (`github/authentication.ts:112-129`).
 * Unlike GitHub's organization-membership endpoint, Discord has no "is this specific user a member of
 * this specific guild" call; the only API is "list every guild the token's user belongs to"
 * (`GET /users/@me/guilds`), so the check here is a membership scan rather than a single lookup. That
 * needs the raw access token `OAuth2Authentication.profile()` would otherwise discard after building
 * the profile, so it is implemented as an override on this subclass — composing after the base
 * `profile()` call can't reach the token to make the second authenticated request.
 */
export default class DiscordAuthentication extends OAuth2Authentication {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, buildDiscordConfig(conf))
  }

  override async profile({ code, redirectUri }: AuthFlowCallback): Promise<ProviderProfile> {
    this.assertConfigured()
    const accessToken = await this.exchangeCode(code, redirectUri)
    if (this.conf.guildId) {
      await this.assertGuildMembership(accessToken)
    }
    const info = await this.fetchUserInfo(accessToken)
    return this.mapProfile(info)
  }

  /**
   * The base mapping, plus the first/last split every single-string provider needs.
   *
   * Discord's user object carries no separated name halves — there is no `given_name`/`family_name`
   * equivalent on it, only `username` (and `global_name`, another single free-text string) — so the
   * split of the display name is the only source there is. It is applied through `fillNameHalves`
   * rather than unconditionally so that a half the generic `oauth2` mapping did establish from a
   * configured claim is never re-guessed; today it never does, and this override does not assume
   * that stays true. The override lives here rather than in `oauth2/authentication.ts` deliberately:
   * a fallback in the base class would fire for every plain-OAuth2 strategy, including ones whose
   * provider reports real halves.
   */
  protected override mapProfile(info: Record<string, any>): ProviderProfile {
    const profile = super.mapProfile(info)
    return { ...profile, ...fillNameHalves(profile.name, profile) }
  }

  /** Confirms the signed-in user belongs to `conf.guildId`, or throws `ERR_LOGIN_RESTRICTED`. */
  private async assertGuildMembership(accessToken: string): Promise<void> {
    const resp = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    })
    // -> A failed membership check is refused the same as an absent one: there is no partial trust to
    //    extend a login on, whether Discord said "no" or just didn't answer (e.g. rate-limited).
    if (!resp.ok) {
      throw new Error('ERR_LOGIN_RESTRICTED')
    }
    let guilds: any
    try {
      guilds = await resp.json()
    } catch {
      throw new Error('ERR_LOGIN_RESTRICTED')
    }
    const isMember =
      Array.isArray(guilds) && guilds.some((guild) => guild?.id === this.conf.guildId)
    if (!isMember) {
      throw new Error('ERR_LOGIN_RESTRICTED')
    }
  }
}
