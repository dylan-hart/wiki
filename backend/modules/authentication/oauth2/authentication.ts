import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'
import { providerNameHalves } from '../../../models/authentication.ts'

/** A userinfo field value as a plain OAuth2 provider reports it: one value, several, or neither. */
function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return (Array.isArray(value) ? value : [value]).map((v) => `${v}`)
}

/**
 * Generic OAuth2
 *
 * The bare authorization-code flow, RFC 6749 and nothing more: no ID token, no discovery document,
 * no signature to verify — an authorization URL built from admin-configured endpoints, a code exchanged
 * for an access token, and a profile read from a configured user-info endpoint using that token. That
 * is little enough to write with `fetch` and no dependency, the same call it was for `github/authentication.ts`
 * rather than the `passport-oauth2` strategy 2.5.x used for this module.
 *
 * `state` is the only part of `AuthFlow` this module reads: it is generated and checked by the shared
 * flow around it (`api/auth/provider.ts`), so there is nothing here to verify beyond passing it through
 * unchanged. `nonce` and `codeVerifier` exist for OIDC/PKCE providers and are simply ignored — a plain
 * OAuth2 provider has no ID token to bind a nonce to, and no client-side secret PKCE would protect.
 *
 * Where an OIDC provider's ID token would carry the subject's identity claims, this module is told
 * where to find the same information on whatever JSON the provider's user-info endpoint answers with:
 * `userIdClaim`, `emailClaim`, `displayNameClaim`. A provider with no verified-email concept (unlike
 * GitHub's `/user/emails`) is simply trusted to report a real address at `emailClaim` — but one that
 * does answer a verification flag can name it via `emailVerifiedClaim`, checked in `mapProfile()`
 * the same way `google/authentication.ts` honours OIDC's `email_verified`: a claim present and
 * `false` refuses the login, an absent claim (unconfigured, or the provider just didn't send it) is
 * accepted unchanged.
 *
 * `assertConfigured`/`exchangeCode`/`fetchUserInfo`/`mapProfile` are `protected` rather than folded
 * into `profile()` so a fixed-endpoint preset built on top of this module — `discord/authentication.ts`
 * is the reason this exists — can override `profile()` to slot in a provider-specific check (Discord's
 * optional guild-membership call) between the token exchange and the userinfo fetch, without
 * reimplementing either. A preset that needs no such hook, like the branded OIDC presets do via
 * `OidcPreset`, would just wrap an instance instead; Discord's guild check needs the raw access token
 * `profile()` would otherwise discard, so composition alone can't reach it — subclassing can.
 */
export default class OAuth2Authentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  constructor(strategyId: string, conf: Record<string, any>) {
    this.strategyId = strategyId
    this.conf = conf
  }

  /** Every field a login actually needs; a preset built on top of this module still has to set them all. */
  protected assertConfigured(): void {
    if (
      !this.conf.clientId ||
      !this.conf.clientSecret ||
      !this.conf.authorizationURL ||
      !this.conf.tokenURL ||
      !this.conf.userInfoURL
    ) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
  }

  async authorizationUrl({ redirectUri, state }: AuthFlow): Promise<string> {
    this.assertConfigured()
    const url = new URL(this.conf.authorizationURL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.conf.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    // -> Omitted rather than sent empty: an admin who configured no scope gets the provider's default.
    const scope = this.effectiveScope()
    if (scope) {
      url.searchParams.set('scope', scope)
    }
    url.searchParams.set('state', state)
    return url.toString()
  }

  /**
   * The scope string actually requested: `conf.scope` (a fixed value for a preset like
   * `discord/authentication.ts`, an admin-entered one for the bare module), plus — when `mapGroups` is
   * on and `groupsScope` names one not already present — whatever scope the provider needs before a
   * group/role field shows up in the userinfo response at all. Mirrors
   * `oidc/authentication.ts`'s `effectiveScope()`; see its comment for why there is no universal
   * default to assume here (OpenProject #826).
   */
  protected effectiveScope(): string | undefined {
    const base: string | undefined = this.conf.scope
    if (!this.conf.mapGroups || !this.conf.groupsScope) {
      return base
    }
    if (!base) {
      return this.conf.groupsScope
    }
    const requested = base.split(/\s+/).filter(Boolean)
    return requested.includes(this.conf.groupsScope) ? base : `${base} ${this.conf.groupsScope}`
  }

  /** POST the authorization code to `tokenURL` and return the access token. */
  protected async exchangeCode(code: string | undefined, redirectUri: string): Promise<string> {
    if (!code) {
      throw new Error('ERR_NO_AUTHORIZATION_CODE')
    }

    const tokenResp = await fetch(this.conf.tokenURL, {
      method: 'POST',
      headers: {
        // -> Ask for JSON: a plain OAuth2 endpoint is free to answer form-encoded otherwise, GitHub's
        //    among them, and a client_secret this module needs to keep off the browser belongs in the
        //    body, not appended to the token URL as a query string.
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.conf.clientId,
        client_secret: this.conf.clientSecret,
        redirect_uri: redirectUri,
        code
      }).toString()
    })
    let token: Record<string, any>
    try {
      token = (await tokenResp.json()) as Record<string, any>
    } catch {
      throw new Error('ERR_TOKEN_EXCHANGE_FAILED')
    }
    // -> Some providers report a refused exchange as 200 with an `error` field, not as a status code
    if (!tokenResp.ok || token.error || !token.access_token) {
      throw new Error('ERR_TOKEN_EXCHANGE_FAILED')
    }
    return token.access_token
  }

  /** GET `userInfoURL` bearing the access token, and return its raw JSON. */
  protected async fetchUserInfo(accessToken: string): Promise<Record<string, any>> {
    const infoResp = await fetch(this.conf.userInfoURL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    })
    if (!infoResp.ok) {
      throw new Error('ERR_TOKEN_EXCHANGE_FAILED')
    }
    return (await infoResp.json()) as Record<string, any>
  }

  /**
   * Map raw userinfo JSON onto a `ProviderProfile` using the configured claim names.
   *
   * Unlike an OIDC provider there is no standard claim to read here -- `emailVerifiedClaim` names
   * whichever field of the userinfo response answers the question, left unset by default because most
   * plain OAuth2 providers have no such concept at all (see the class doc comment). Only a claim that is
   * explicitly `false` refuses the login: an unconfigured or absent claim is not assumed unverified.
   */
  protected mapProfile(info: Record<string, any>): ProviderProfile {
    const id = info[this.conf.userIdClaim || 'id']
    if (id === undefined || id === null || id === '') {
      throw new Error('ERR_NO_PROVIDER_ACCOUNT')
    }

    const email = info[this.conf.emailClaim || 'email']
    if (!email || typeof email !== 'string') {
      throw new Error('ERR_NO_EMAIL_FROM_PROVIDER')
    }

    if (this.conf.emailVerifiedClaim) {
      const emailVerified = info[this.conf.emailVerifiedClaim]
      if (emailVerified === false && this.conf.allowUnverifiedEmail !== true) {
        throw new Error('ERR_EMAIL_NOT_VERIFIED')
      }
    }

    return {
      id: String(id),
      email,
      name: (info[this.conf.displayNameClaim || 'displayName'] as string) || email,
      // -> Read only; whether either half reaches the account, and what `name` derives to, is
      //    `models/users.ts`'s decision (Feature #2608). A plain OAuth2 provider has no standard
      //    claim for either -- hence the two configurable names, defaulted to the camelCase pair
      //    `displayNameClaim` above already assumes rather than OIDC's snake_case. Deliberately not
      //    done here: splitting the display name when the provider issues no halves. Every branded
      //    preset built on this class inherits this method, so that fallback belongs in the preset
      //    that needs it (Task #2641), not in the base.
      ...providerNameHalves(
        info[this.conf.firstNameClaim || 'firstName'],
        info[this.conf.lastNameClaim || 'lastName']
      ),
      // -> `undefined` (module did not look) versus `[]` (looked, provider reported none) matters to
      //    `syncProviderGroups()` — see `ProviderProfile.groups`'s own doc comment — so the key itself
      //    is only ever present when `mapGroups` is on, never set to `undefined`.
      ...(this.conf.mapGroups
        ? { groups: asStringArray(info[this.conf.groupsClaim || 'groups']) }
        : {})
    }
  }

  async profile({ code, redirectUri }: AuthFlowCallback): Promise<ProviderProfile> {
    this.assertConfigured()
    const accessToken = await this.exchangeCode(code, redirectUri)
    const info = await this.fetchUserInfo(accessToken)
    return this.mapProfile(info)
  }

  /** Where a logout should continue, so that the session at the provider ends too. */
  logoutUrl(): string | null {
    return this.conf.logoutURL || null
  }
}
