import { splitDisplayName } from '../../../helpers/personName.ts'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

const MAX_TEAM_PAGES = 50

/**
 * GitHub speaks OAuth 2.0, not OpenID Connect: there is no ID token and so nothing to verify
 * signatures on — the access token is spent against the API, which answers who it belongs to. That
 * is the whole protocol, hence bare `fetch` and no dependency. `state` and keeping the client secret
 * off the browser are the surrounding flow's job (`api/auth/provider.ts`).
 */
export default class GitHubAuthentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  constructor(strategyId: string, conf: Record<string, any>) {
    this.strategyId = strategyId
    this.conf = conf
  }

  /** The sign-in host and the API host differ on Enterprise Server. */
  private get hosts(): { web: string; api: string } {
    const enterprise = (this.conf.enterpriseHost || '').trim().replace(/^https?:\/\//, '')
    return enterprise
      ? { web: `https://${enterprise}`, api: `https://${enterprise}/api/v3` }
      : { web: 'https://github.com', api: 'https://api.github.com' }
  }

  private async apiRequest(url: string, accessToken: string): Promise<Response> {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Cardinal.js'
      }
    })
    if (!resp.ok) {
      throw new Error(`ERR_PROVIDER_REQUEST_FAILED`)
    }
    return resp
  }

  private async api(path: string, accessToken: string): Promise<any> {
    return (await this.apiRequest(`${this.hosts.api}${path}`, accessToken)).json()
  }

  private async teams(accessToken: string): Promise<string[]> {
    const only = (this.conf.allowedOrganization || '').trim().toLowerCase()
    const names: string[] = []
    let next: string | null = `${this.hosts.api}/user/teams?per_page=100`
    for (let page = 0; next; page++) {
      if (page >= MAX_TEAM_PAGES) {
        throw new Error('ERR_PROVIDER_REQUEST_FAILED')
      }
      const resp = await this.apiRequest(next, accessToken)
      const entries = await resp.json()
      if (!Array.isArray(entries)) {
        throw new Error('ERR_PROVIDER_REQUEST_FAILED')
      }
      for (const entry of entries) {
        const org = entry?.organization?.login
        if (typeof org !== 'string' || typeof entry?.slug !== 'string') {
          continue
        }
        if (only && org.toLowerCase() !== only) {
          continue
        }
        names.push(`${org}/${entry.slug}`)
      }
      next = /<([^>]+)>\s*;\s*rel="next"/.exec(resp.headers.get('link') || '')?.[1] ?? null
      if (next && !next.startsWith(`${this.hosts.api}/`)) {
        throw new Error('ERR_PROVIDER_REQUEST_FAILED')
      }
    }
    return names
  }

  async authorizationUrl({ redirectUri, state }: AuthFlow): Promise<string> {
    if (!this.conf.clientId || !this.conf.clientSecret) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    const url = new URL(`${this.hosts.web}/login/oauth/authorize`)
    url.searchParams.set('client_id', this.conf.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    /*
      `user:email` is what makes the verified addresses readable; `read:org` is asked for only when an
      organization is enforced or teams are mapped to groups, since a scope nobody needs is a scope
      nobody should be granting.
    */
    url.searchParams.set(
      'scope',
      this.conf.allowedOrganization || this.conf.mapGroups
        ? 'read:user user:email read:org'
        : 'read:user user:email'
    )
    url.searchParams.set('state', state)
    return url.toString()
  }

  async profile({ code, redirectUri }: AuthFlowCallback): Promise<ProviderProfile> {
    if (!code) {
      throw new Error('ERR_NO_AUTHORIZATION_CODE')
    }
    // -> `Accept: application/json`, or GitHub answers this one in form encoding
    const tokenResp = await fetch(`${this.hosts.web}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Cardinal.js'
      },
      body: JSON.stringify({
        client_id: this.conf.clientId,
        client_secret: this.conf.clientSecret,
        redirect_uri: redirectUri,
        code
      })
    })
    const token = (await tokenResp.json()) as Record<string, any>
    // -> GitHub reports a refused exchange as 200 with an `error` field, not as a status
    if (!tokenResp.ok || token.error || !token.access_token) {
      throw new Error('ERR_TOKEN_EXCHANGE_FAILED')
    }

    const account = await this.api('/user', token.access_token)
    if (!account?.id) {
      throw new Error('ERR_NO_PROVIDER_ACCOUNT')
    }

    /*
      `/user/emails`, not `account.email`: the latter is only whatever the profile shows publicly, is
      frequently null, and is never verified by GitHub.
    */
    const emails: any[] = await this.api('/user/emails', token.access_token)
    const email = emails?.find((entry) => entry.primary && entry.verified)?.email
    if (!email) {
      throw new Error('ERR_NO_VERIFIED_EMAIL_FROM_PROVIDER')
    }

    if (this.conf.allowedOrganization) {
      const org = this.conf.allowedOrganization.trim()
      const resp = await fetch(
        `${this.hosts.api}/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(account.login)}`,
        {
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Cardinal.js'
          }
        }
      )
      // -> 204 is a member, 302 is "ask as somebody who can see", 404 is not a member
      if (resp.status !== 204) {
        throw new Error('ERR_LOGIN_RESTRICTED')
      }
    }

    /*
      GitHub's REST user object carries one free-text `name` and no separated halves, so the split is
      the only source there is. A blank `name` falls back to `login`, a handle rather than a name,
      which therefore lands whole in `firstName` with no surname fabricated for it.
    */
    const name = account.name || account.login
    const groups = this.conf.mapGroups ? await this.teams(token.access_token) : undefined
    return {
      id: String(account.id),
      email,
      name,
      ...splitDisplayName(name),
      // -> An absent `avatar_url` means "did not say": the key is left off rather than guessed at.
      ...(typeof account.avatar_url === 'string' && account.avatar_url.trim()
        ? { picture: account.avatar_url }
        : {}),
      ...(groups ? { groups } : {})
    }
  }
}
