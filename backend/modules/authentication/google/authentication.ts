import * as client from 'openid-client'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'
import { providerNameHalves } from '../../../models/authentication.ts'
import { fetchWorkspaceGroups } from './groups.ts'

const ISSUER = 'https://accounts.google.com'

/**
 * Exported standalone so the claim reading can be asserted without a network round trip or a signed
 * token; everything upstream of it is `openid-client`'s own tested job.
 *
 * No configurable claim names, unlike the generic OIDC module: Google issues the standard
 * `given_name`/`family_name`/`picture`. A half Google does not report is left off the profile
 * rather than defaulted, so a mononym stays one.
 */
export function mapGoogleProfile(
  conf: Record<string, any>,
  claims: Record<string, any>
): ProviderProfile {
  const email = claims.email
  if (!email || typeof email !== 'string') {
    throw new Error('ERR_NO_EMAIL_FROM_PROVIDER')
  }
  if (claims.email_verified === false && conf.allowUnverifiedEmail !== true) {
    throw new Error('ERR_EMAIL_NOT_VERIFIED')
  }
  if (conf.hostedDomain && claims.hd !== conf.hostedDomain) {
    throw new Error('ERR_LOGIN_RESTRICTED')
  }
  return {
    id: claims.sub,
    email,
    name: (claims.name as string) || email,
    ...providerNameHalves(claims.given_name, claims.family_name),
    ...(typeof claims.picture === 'string' && claims.picture.trim()
      ? { picture: claims.picture }
      : {})
  }
}

export async function googleProfileWithGroups(
  conf: Record<string, any>,
  claims: Record<string, any>,
  fetchGroups: (
    conf: Record<string, any>,
    email: string
  ) => Promise<string[]> = fetchWorkspaceGroups
): Promise<ProviderProfile> {
  const profile = mapGoogleProfile(conf, claims)
  if (!conf.mapGroups) {
    return profile
  }
  return { ...profile, groups: await fetchGroups(conf, profile.email) }
}

/**
 * The generic OIDC flow with the issuer fixed, plus two Google specifics:
 *
 *   - a required Workspace domain is checked against the `hd` claim, not just asked for — `hd` on
 *     the authorization request is a hint to the account chooser, not a promise about the answer;
 *   - `email_verified` is honoured, because an account here is matched by email address and an
 *     unverified one says nothing about who holds the mailbox.
 *
 * On `openid-client` rather than hand-rolled because the ID token has to be verified, and a token
 * nobody verified still logs somebody in.
 */
export default class GoogleAuthentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  private config: client.Configuration | null = null

  constructor(strategyId: string, conf: Record<string, any>) {
    this.strategyId = strategyId
    this.conf = conf
  }

  private async configuration(): Promise<client.Configuration> {
    if (this.config) {
      return this.config
    }
    if (!this.conf.clientId || !this.conf.clientSecret) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    this.config = await client.discovery(
      new URL(ISSUER),
      this.conf.clientId,
      this.conf.clientSecret
    )
    return this.config
  }

  async authorizationUrl({ redirectUri, state, nonce, codeVerifier }: AuthFlow): Promise<string> {
    const config = await this.configuration()
    return client
      .buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        // -> Which accounts the chooser offers. The answer is still checked below.
        ...(this.conf.hostedDomain ? { hd: this.conf.hostedDomain } : {})
      })
      .toString()
  }

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
    const claims = tokens.claims() as Record<string, any> | undefined
    if (!claims?.sub) {
      throw new Error('ERR_NO_ID_TOKEN')
    }

    return googleProfileWithGroups(this.conf, claims)
  }
}
