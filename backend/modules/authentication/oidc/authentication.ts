import * as client from 'openid-client'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'
import { providerNameHalves } from '../../../models/authentication.ts'

/** A claim value as OIDC providers report it: one value, several, or (rarely) neither. */
function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return (Array.isArray(value) ? value : [value]).map((v) => `${v}`)
}

/**
 * Map the merged ID-token claims and userinfo response onto a `ProviderProfile`, using the configured
 * claim names. Exported standalone (mirroring `buildOidcConfig` in `preset.ts`) so the claim-mapping —
 * including the `mapGroups`/`groupsClaim` behavior every OIDC preset inherits — can be asserted
 * directly, with no network or ID-token verification involved: everything upstream of this is
 * `openid-client` itself, already covered by its own test suite.
 *
 * `email_verified` is honoured the way `google/authentication.ts` already does: an account here is
 * matched by email address, so an address the provider itself has not verified says nothing about who
 * holds the mailbox. Every OIDC preset (auth0, okta, microsoft, keycloak, gitlab, twitch, slack) routes
 * through this same function, so the check applies to all of them with no per-preset code. Only a
 * claim that is explicitly `false` refuses the login -- a provider that omits the claim entirely (many
 * do) is not assumed unverified, since there is nothing to contradict.
 *
 * The separated name halves come from OIDC's own standard `given_name`/`family_name` claims, each
 * overridable by `firstNameClaim`/`lastNameClaim` for a provider that puts them somewhere else — the
 * same shape `displayNameClaim` already has, since a claim name is exactly the kind of thing an
 * administrator has to be able to correct. They are read here and nowhere else: whether either half
 * is written to the account, and what `name` derives to, is `models/users.ts`'s decision (Feature
 * #2608), not this module's. Deliberately NOT done here: splitting the display name when the
 * provider issues no halves at all — that fallback is per-module (Task #2641), and doing it in this
 * shared mapper would silently apply it to every OIDC preset.
 */
export function mapOidcProfile(
  conf: Record<string, any>,
  subject: string,
  info: Record<string, any>
): ProviderProfile {
  const email = info[conf.emailClaim || 'email']
  if (!email || typeof email !== 'string') {
    throw new Error('ERR_NO_EMAIL_FROM_PROVIDER')
  }
  const emailVerified = info.email_verified
  if (emailVerified === false && conf.allowUnverifiedEmail !== true) {
    throw new Error('ERR_EMAIL_NOT_VERIFIED')
  }
  return {
    id: subject,
    email,
    name: (info[conf.displayNameClaim || 'name'] as string) || email,
    ...providerNameHalves(
      info[conf.firstNameClaim || 'given_name'],
      info[conf.lastNameClaim || 'family_name']
    ),
    // -> `undefined` (module did not look) versus `[]` (looked, provider reported none) matters to
    //    `syncProviderGroups()` — see `ProviderProfile.groups`'s own doc comment — so the key itself
    //    is only ever present when `mapGroups` is on, never set to `undefined`.
    ...(conf.mapGroups ? { groups: asStringArray(info[conf.groupsClaim || 'groups']) } : {})
  }
}

/**
 * Generic OpenID Connect / OAuth2
 *
 * The authorization code flow with PKCE, against any provider that speaks OpenID Connect. What makes
 * it OIDC rather than bare OAuth2 is the ID token: a signed statement of who signed in, which is
 * verified here against the provider's published keys — issuer, audience, nonce and signature — before
 * anything is believed about the person behind it.
 *
 * That verification is why this goes through `openid-client` rather than a handful of `fetch` calls.
 * The requests themselves are trivial; the checks around them are where a mistake is silent, because
 * a token that is never verified still logs somebody in.
 */
export default class OidcAuthentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  /**
   * The provider as `openid-client` sees it. Built once and kept: with discovery on it is a network
   * round trip, and it is the same answer for every login until the strategy is saved again.
   */
  private config: client.Configuration | null = null

  constructor(strategyId: string, conf: Record<string, any>) {
    this.strategyId = strategyId
    this.conf = conf
  }

  /**
   * Resolve the provider's metadata.
   *
   * Discovery is the path worth taking: the endpoints AND the signing keys come from the issuer
   * itself, so a provider rotating either is followed without an administrator editing anything. The
   * manual path exists for providers that publish no discovery document, and needs the JWKS URL for
   * the same reason — without keys there is nothing to check the ID token against.
   */
  private async configuration(): Promise<client.Configuration> {
    if (this.config) {
      return this.config
    }
    const { clientId, clientSecret, issuer } = this.conf
    if (!clientId || !clientSecret || !issuer) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    if (this.conf.useDiscovery !== false) {
      this.config = await client.discovery(new URL(issuer), clientId, clientSecret)
    } else {
      if (!this.conf.authorizationURL || !this.conf.tokenURL || !this.conf.jwksURL) {
        throw new Error('ERR_STRATEGY_MISCONFIGURED')
      }
      this.config = new client.Configuration(
        {
          issuer,
          authorization_endpoint: this.conf.authorizationURL,
          token_endpoint: this.conf.tokenURL,
          userinfo_endpoint: this.conf.userInfoURL || undefined,
          jwks_uri: this.conf.jwksURL
        },
        clientId,
        clientSecret
      )
    }
    return this.config
  }

  /** Where to send the browser to sign in. */
  async authorizationUrl({ redirectUri, state, nonce, codeVerifier }: AuthFlow): Promise<string> {
    const config = await this.configuration()
    return client
      .buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: this.effectiveScope(),
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        // -> A handful of providers need something extra on the authorization request that no
        //    other field here covers — Twitch wants a `claims` parameter asking for email even
        //    though PKCE is in play. Set per-preset via `OidcPresetTemplate.extraAuthParams`.
        ...this.conf.extraAuthParams
      })
      .toString()
  }

  /**
   * The scope string actually requested: the configured scopes, plus — when `mapGroups` is on and
   * `groupsScope` names one not already present — whatever scope the provider needs before it will
   * put group membership on the ID token or userinfo response at all.
   *
   * This exists because upstream's Generic OpenID Connect strategy could map a `groups` claim while
   * never requesting the scope that made a provider populate it, so membership silently vanished on
   * login (OpenProject #826). `groupsScope` is opt-in and provider-specific — Okta and Keycloak both
   * gate group membership behind a scope literally named `groups`, but plenty of providers (Auth0's
   * claim comes from a rule/Action, Microsoft's from the app manifest) need no extra scope at all, so
   * there is no universally-correct default to assume here.
   */
  private effectiveScope(): string {
    const base: string = this.conf.scopes || 'openid profile email'
    if (!this.conf.mapGroups || !this.conf.groupsScope) {
      return base
    }
    const requested = base.split(/\s+/).filter(Boolean)
    return requested.includes(this.conf.groupsScope) ? base : `${base} ${this.conf.groupsScope}`
  }

  /**
   * Turn the code the provider sent back into who signed in.
   *
   * `authorizationCodeGrant` is what does the checking: it refuses a response whose state does not
   * match the one this flow started with, exchanges the code with the PKCE verifier, and validates
   * the ID token's signature, issuer, audience and nonce. Everything after it is reading claims.
   */
  async profile({
    currentUrl,
    state,
    nonce,
    codeVerifier
  }: AuthFlowCallback): Promise<ProviderProfile> {
    const config = await this.configuration()
    const tokens = await client.authorizationCodeGrant(config, new URL(currentUrl), {
      expectedState: state,
      expectedNonce: nonce,
      pkceCodeVerifier: codeVerifier
    })
    const claims = tokens.claims()
    if (!claims?.sub) {
      throw new Error('ERR_NO_ID_TOKEN')
    }

    /*
      The userinfo endpoint is consulted when the provider has one, because a provider is free to keep
      claims out of the ID token and behind it — several put the email address there only. Its answer
      is merged over the token's, and `fetchUserInfo` checks that it is about the same subject.
    */
    let info: Record<string, any> = claims
    if (config.serverMetadata().userinfo_endpoint) {
      info = {
        ...claims,
        ...(await client.fetchUserInfo(config, tokens.access_token, claims.sub))
      }
    }

    return mapOidcProfile(this.conf, claims.sub, info)
  }

  /** Where a logout should continue, so that the session at the provider ends too. */
  logoutUrl(): string | null {
    return this.conf.logoutURL || null
  }
}
