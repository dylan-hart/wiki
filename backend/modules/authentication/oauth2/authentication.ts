import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'
import { providerNameHalves } from '../../../models/authentication.ts'

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return (Array.isArray(value) ? value : [value]).map((v) => `${v}`)
}

/**
 * The bare RFC 6749 authorization-code flow: no ID token, no discovery document, no signature to
 * verify — little enough to write with `fetch` and no strategy dependency.
 *
 * `state` is the only part of `AuthFlow` read here; it is generated and checked by the shared flow
 * around it (`api/auth/provider.ts`). `nonce` and `codeVerifier` are ignored because a plain OAuth2
 * provider has no ID token to bind a nonce to and no client-side secret PKCE would protect.
 *
 * `assertConfigured`/`exchangeCode`/`fetchUserInfo`/`mapProfile` are `protected` so a fixed-endpoint
 * preset can override `profile()` to slot a provider-specific step (Discord's guild-membership
 * check) between the token exchange and the userinfo fetch. That step needs the raw access token
 * `profile()` would otherwise discard, so wrapping an instance cannot reach it — subclassing can.
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
   * `conf.scope` plus, when `mapGroups` is on, whatever extra scope this particular provider needs
   * before a group/role field shows up in the userinfo response at all. There is no universal
   * default to assume, so the scope is admin-named rather than hardcoded.
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

  protected async exchangeCode(code: string | undefined, redirectUri: string): Promise<string> {
    if (!code) {
      throw new Error('ERR_NO_AUTHORIZATION_CODE')
    }

    const tokenResp = await fetch(this.conf.tokenURL, {
      method: 'POST',
      headers: {
        // -> Ask for JSON: a plain OAuth2 endpoint is otherwise free to answer form-encoded, GitHub
        //    among them. The secret goes in the body, never in the token URL's query string.
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
   * Unlike OIDC there is no standard verified-email claim, so `emailVerifiedClaim` names whichever
   * userinfo field answers the question and is unset by default -- most plain OAuth2 providers have
   * no such concept. Only an explicitly `false` claim refuses the login: an unconfigured or absent
   * one is not assumed unverified.
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
      // -> Read only; whether either half reaches the account is `models/users.ts`'s decision.
      //    Splitting the display name when the provider issues no halves is deliberately not done
      //    here: every branded preset inherits this method, so that fallback belongs in the preset
      //    that needs it, not in the base.
      ...providerNameHalves(
        info[this.conf.firstNameClaim || 'firstName'],
        info[this.conf.lastNameClaim || 'lastName']
      ),
      // -> `undefined` (module did not look) and `[]` (looked, provider reported none) mean
      //    different things to `syncProviderGroups()`, so the key is absent unless `mapGroups` is
      //    on, never set to `undefined`.
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

  logoutUrl(): string | null {
    return this.conf.logoutURL || null
  }
}
