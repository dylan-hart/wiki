/* global WIKI */
import { XMLParser } from 'fast-xml-parser'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

const xmlParser = new XMLParser({ removeNSPrefix: true })

/** What `serviceValidate` reported, before it is mapped into a `ProviderProfile`. */
interface CasValidation {
  username: string
  /** CAS 1.0 never has any of these — see the module's own doc comment. */
  attrs: Record<string, unknown>
}

/**
 * A CAS attribute value, once parsed out of `<cas:attributes>`: a bare scalar for one value, an array
 * for more than one (a released attribute repeated as several like-named elements), or an empty object
 * for a self-closing element with no text. Only the first value is ever used here, same as every other
 * module's `firstOf()` — none of this module's three mapped attributes (unique ID, email, display name)
 * take more than one value.
 */
function firstOf(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return v === undefined || v === null || typeof v === 'object' ? undefined : `${v}`
}

/**
 * CAS (Central Authentication Service)
 *
 * A redirect-based module, like OAuth2/OIDC and SAML, but predating both and with no client library on
 * npm that fits this fork's non-`passport` pattern the way `openid-client` and `@node-saml/node-saml`
 * do for those two — so this module talks the protocol directly. It has exactly two moving parts:
 * `GET /login?service=` to send the browser off, and `GET /serviceValidate` (CAS 1.0) or
 * `GET /p3/serviceValidate` (CAS 3.0) to redeem the `ticket` CAS hands back for who authenticated.
 *
 * CAS defines no `state` parameter of its own — see `AuthFlow.state` in `models/authentication.ts` for
 * the full reasoning. In short: `state` is appended as a query parameter onto the `service` URL this
 * module registers, and CAS preserves whatever query string a `service` already had when it appends its
 * own `?ticket=` — so the GET `/auth/:strategyId/callback` route reads `state` back exactly the way it
 * does for a plain OAuth2 provider, with no framework changes needed beyond adding `ticket` alongside
 * `code` on that route's querystring. `authorizationUrl()` and `profile()` both rebuild that same
 * `service` string from `redirectUri` + `state`, since CAS requires `serviceValidate`'s own `service`
 * parameter to match, character for character, the one the ticket was actually issued against.
 *
 * CAS 1.0's answer is two lines of plain text (`yes\n<username>` or `no\n\n`) and reports no attributes
 * at all — so `emailAttribute`/`displayNameAttribute` are gated out of the admin form entirely once
 * `casVersion` is set to `CAS1.0` (see `definition.yml`), and `id`/`name` always fall back to the bare
 * username. `email`, though, is never fabricated out of that username: per `ProviderProfile`'s own
 * doc comment in `models/authentication.ts`, an account is matched or created by an address this module
 * has established belongs to the person, and an unverified username is not that. A CAS 1.0 strategy
 * therefore has no way to provision or log in an account through this framework's email-keyed model —
 * a real, documented limitation of the protocol version, not a bug here.
 */
export default class CasAuthentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  constructor(strategyId: string, conf: Record<string, any>) {
    this.strategyId = strategyId
    this.conf = conf
  }

  private casVersion(): 'CAS3.0' | 'CAS1.0' {
    return this.conf.casVersion === 'CAS1.0' ? 'CAS1.0' : 'CAS3.0'
  }

  /**
   * The `service` this module registers with CAS, and later re-presents to `serviceValidate` to redeem
   * a ticket against. `redirectUri` is the callback URL the framework already builds per-request (see
   * `callbackUrl()` in `api/auth/provider.ts`) — not the strategy's own `baseUrl` config field, which
   * exists only for parity with 2.5.x's field set and is not read by this module; nothing here needs an
   * administrator-supplied base URL when the framework already computes an equivalent one dynamically.
   */
  private serviceUrl(redirectUri: string, state: string): string {
    return `${redirectUri}?state=${state}`
  }

  async authorizationUrl({ redirectUri, state }: AuthFlow): Promise<string> {
    if (!this.conf.casUrl) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    const service = this.serviceUrl(redirectUri, state)
    return `${this.conf.casUrl}/login?service=${encodeURIComponent(service)}`
  }

  /**
   * Redeem the `ticket` CAS granted, and map who it belongs to.
   *
   * `ticket` (not `code`) is what carries the answer for this protocol — read off the callback's
   * querystring by the GET `/auth/:strategyId/callback` route, same as `code` is for OAuth2/OIDC.
   */
  async profile(flowCallback: AuthFlowCallback): Promise<ProviderProfile> {
    if (!this.conf.casUrl) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    if (!flowCallback.ticket) {
      throw new Error('ERR_NO_CAS_TICKET')
    }

    const casVersion = this.casVersion()
    const service = this.serviceUrl(flowCallback.redirectUri, flowCallback.state)
    const validatePath = casVersion === 'CAS3.0' ? 'p3/serviceValidate' : 'serviceValidate'
    const url = new URL(`${this.conf.casUrl}/${validatePath}`)
    url.searchParams.set('service', service)
    url.searchParams.set('ticket', flowCallback.ticket)

    let text: string
    try {
      const res = await fetch(url)
      text = await res.text()
    } catch (err: any) {
      WIKI.models.flags.authDebug(
        `CAS strategy ${this.strategyId}: serviceValidate request failed: ${err.message}`
      )
      throw new Error('ERR_CAS_LOGIN_FAILED')
    }

    const { username, attrs } =
      casVersion === 'CAS3.0' ? this.parseCas3Response(text) : this.parseCas1Response(text)

    // -> `id`/`name` fall back to the bare CAS username whenever the mapped attribute is either left
    //    unconfigured or simply absent from what CAS reported — CAS 1.0's `attrs` is always empty, so
    //    both always take this path there.
    const id = firstOf(attrs[this.conf.uniqueIdAttribute]) || username
    const name = firstOf(attrs[this.conf.displayNameAttribute]) || username
    const email = firstOf(attrs[this.conf.emailAttribute])
    if (!email) {
      throw new Error('ERR_NO_EMAIL_FROM_PROVIDER')
    }

    return { id, email, name }
  }

  private parseCas1Response(text: string): CasValidation {
    const [status, username] = text.split('\n')
    if (status?.trim() !== 'yes' || !username?.trim()) {
      WIKI.models.flags.authDebug(
        `CAS strategy ${this.strategyId}: ticket validation failed (CAS 1.0)`
      )
      throw new Error('ERR_CAS_LOGIN_FAILED')
    }
    return { username: username.trim(), attrs: {} }
  }

  private parseCas3Response(text: string): CasValidation {
    let parsed: any
    try {
      parsed = xmlParser.parse(text)
    } catch (err: any) {
      WIKI.models.flags.authDebug(
        `CAS strategy ${this.strategyId}: could not parse the serviceValidate response: ${err.message}`
      )
      throw new Error('ERR_CAS_LOGIN_FAILED')
    }
    const success = parsed?.serviceResponse?.authenticationSuccess
    if (!success?.user) {
      WIKI.models.flags.authDebug(
        `CAS strategy ${this.strategyId}: ticket validation failed (CAS 3.0)`
      )
      throw new Error('ERR_CAS_LOGIN_FAILED')
    }
    return { username: `${success.user}`, attrs: success.attributes ?? {} }
  }
}
