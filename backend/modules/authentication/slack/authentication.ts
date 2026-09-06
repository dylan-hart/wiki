import { OidcPreset } from '../oidc/preset.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/**
 * Slack
 *
 * "Sign in with Slack" is genuine OpenID Connect, not the plain OAuth2 flow 2.5.x's
 * `slack/authentication.js` used (`passport-slack-oauth2`, `identity.email` scope). Confirmed live
 * during this task rather than assumed: `https://slack.com/.well-known/openid-configuration` answers
 * with a full discovery document (authorization/token/userinfo endpoints, JWKS, RS256-signed ID
 * tokens), and Slack's own docs describe the flow as "built on top of OAuth 2.0" and interoperable
 * with any standard OIDC client — see docs/auth-provider-audit.md for the sourcing and the
 * reclassification this caused. Slack's issuer is fixed, like Twitch's, so there is no per-tenant
 * domain/org prop for the admin to fill in.
 *
 * The one thing a generic OIDC config can't express is Slack's optional workspace restriction: a
 * `team` parameter on the authorization request that, per Slack's docs, "restricts authentication to
 * a specific workspace" (and skips the consent screen for a user already signed into it). That is the
 * OIDC-flow analogue of Discord's guild check, but Slack's version needs no second authenticated API
 * call — Slack enforces it during the authorization step itself — so it is expressed entirely through
 * `extraAuthParams`, conditionally, via the function form `oidc/preset.ts` added for this reason.
 */
export default class SlackAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: () => 'https://slack.com',
      scopes: 'openid email profile',
      extraAuthParams: (c) => (c.teamId ? { team: c.teamId } : undefined)
    })
  }

  /**
   * Slack's userinfo response is one display string as far as this fork reads it — the generic OIDC
   * mapping takes `name` and nothing else — so the two name fields this instance stores come from the
   * naive split, applied only where nothing better was established. `fillNameHalves` is what makes
   * that conditional: if the shared OIDC mapping later reads Slack's own `given_name`/`family_name`
   * claims (it publishes them under the `profile` scope this preset already requests), what the
   * provider actually said wins and nothing is re-guessed here.
   *
   * This is an override on the preset rather than an edit to `oidc/preset.ts`, so it reaches Slack
   * alone: a fallback on the shared base would fire for auth0/okta/microsoft/keycloak/gitlab too and
   * silently pre-empt whatever those read from real claims.
   */
  override async profile(flow: AuthFlowCallback): Promise<ProviderProfile> {
    const profile = await super.profile(flow)
    return { ...profile, ...fillNameHalves(profile.name, profile) }
  }
}
