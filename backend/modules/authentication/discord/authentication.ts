import OAuth2Authentication from '../oauth2/authentication.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

function buildDiscordConfig(conf: Record<string, any>): Record<string, any> {
  return {
    ...conf,
    authorizationURL: 'https://discord.com/api/oauth2/authorize',
    tokenURL: 'https://discord.com/api/oauth2/token',
    userInfoURL: 'https://discord.com/api/users/@me',
    // -> `guilds` is Discord's own least-privilege gate on `/users/@me/guilds`, so it is asked for
    //    only when a guild restriction is actually configured.
    scope: conf.guildId ? 'identify email guilds' : 'identify email',
    userIdClaim: 'id',
    emailClaim: 'email',
    // -> Discord has no `displayName`, and `global_name` is null for a user who never set one;
    //    `username` is the only field always present.
    displayNameClaim: 'username',
    // -> Naming Discord's sibling `verified` boolean is what makes the base `mapProfile()` enforce it.
    emailVerifiedClaim: 'verified'
  }
}

/**
 * Plain OAuth2, not OIDC: `discord.com/.well-known/openid-configuration` answers 200, but
 * `response_types_supported` carries no `id_token` and Discord issues none — a discovery document
 * alone is not OIDC. Hence the generic `oauth2` module rather than an `OidcPreset`.
 *
 * `profile()` is overridden rather than composed because the optional guild (server) restriction needs
 * the raw access token the base `profile()` discards: Discord has no "is this user in this guild" call,
 * only `GET /users/@me/guilds`, so the check is a membership scan needing a second authenticated
 * request.
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
   * Discord reports no separated name halves, so the display-name split is the only source there is.
   * `fillNameHalves` leaves alone any half the base mapping did establish from a configured claim.
   * The split belongs here and not in `oauth2/authentication.ts`, where it would fire for every
   * plain-OAuth2 strategy, including ones whose provider reports real halves.
   */
  protected override mapProfile(info: Record<string, any>): ProviderProfile {
    const profile = super.mapProfile(info)
    return { ...profile, ...fillNameHalves(profile.name, profile) }
  }

  private async assertGuildMembership(accessToken: string): Promise<void> {
    const resp = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    })
    // -> Fail closed: an unanswered check (rate limit, outage) is refused the same as a "no".
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
