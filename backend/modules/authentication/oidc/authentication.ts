import * as client from 'openid-client'
import { buildEndSessionUrl, type EndSessionParams } from '../../../helpers/endSessionUrl.ts'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'
import { providerNameHalves } from '../../../models/authentication.ts'

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return (Array.isArray(value) ? value : [value]).map((v) => `${v}`)
}

/**
 * An account here is matched by email address, so an address the provider itself has not verified
 * says nothing about who holds the mailbox. Only an explicitly `false` `email_verified` refuses the
 * login -- a provider that omits the claim entirely (many do) contradicts nothing.
 *
 * Splitting the display name when the provider issues no `given_name`/`family_name` is deliberately
 * NOT done here: that fallback is per-module, and this shared mapper would apply it to every OIDC
 * preset.
 *
 * A missing or blank `picture` claim leaves the key absent rather than fabricating a default —
 * `models/users.ts#syncAvatarFromProvider` reads absence as "the provider did not say" and leaves
 * any existing avatar alone.
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
  const picture = info[conf.pictureClaim || 'picture']
  return {
    id: subject,
    email,
    name: (info[conf.displayNameClaim || 'name'] as string) || email,
    ...providerNameHalves(
      info[conf.firstNameClaim || 'given_name'],
      info[conf.lastNameClaim || 'family_name']
    ),
    // -> `undefined` (module did not look) and `[]` (looked, provider reported none) mean different
    //    things to `syncProviderGroups()`, so the key is absent unless `mapGroups` is on, never set
    //    to `undefined`.
    ...(conf.mapGroups ? { groups: asStringArray(info[conf.groupsClaim || 'groups']) } : {}),
    ...(typeof picture === 'string' && picture.trim() ? { picture } : {})
  }
}

/**
 * The authorization code flow with PKCE. What makes it OIDC rather than bare OAuth2 is the ID token:
 * a signed statement of who signed in, verified against the provider's published keys — issuer,
 * audience, nonce and signature — before anything is believed about the person behind it.
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
   * Cached: with discovery on, building this is a network round trip, and the answer is the same for
   * every login until the strategy is saved again.
   */
  private config: client.Configuration | null = null

  constructor(strategyId: string, conf: Record<string, any>) {
    this.strategyId = strategyId
    this.conf = conf
  }

  /**
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
        //    other field here covers — Twitch wants a `claims` parameter asking for email.
        ...this.conf.extraAuthParams
      })
      .toString()
  }

  /**
   * The configured scopes, plus — when `mapGroups` is on — whatever scope the provider needs before
   * it will report group membership at all: mapping a `groups` claim without requesting that scope
   * silently yields no membership. `groupsScope` is opt-in and provider-specific (Okta and Keycloak
   * gate membership behind a scope literally named `groups`; Auth0's comes from a rule/Action and
   * Microsoft's from the app manifest, needing none), so there is no correct default to assume.
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
      A provider is free to keep claims out of the ID token and behind the userinfo endpoint —
      several put the email address there only. Its answer is merged over the token's, and
      `fetchUserInfo` checks that it is about the same subject.
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

  logoutUrl(params: EndSessionParams = {}): string | null {
    return buildEndSessionUrl(this.conf.logoutURL, params)
  }
}
