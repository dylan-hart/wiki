import { OidcPreset } from '../oidc/preset.ts'

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
}
