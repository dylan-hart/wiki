/* global CARDINAL */
import { XMLParser } from 'fast-xml-parser'
import { splitDisplayName } from '../../../helpers/personName.ts'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

const xmlParser = new XMLParser({ removeNSPrefix: true })

interface CasValidation {
  username: string
  attrs: Record<string, unknown>
}

/**
 * A parsed `<cas:attributes>` value is a bare scalar for one value, an array when the attribute is
 * released as several like-named elements, or an empty object for a self-closing element with no text.
 */
function firstOf(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return v === undefined || v === null || typeof v === 'object' ? undefined : `${v}`
}

/**
 * CAS is spoken directly: no npm client fits this fork's non-`passport` pattern the way
 * `openid-client` and `@node-saml/node-saml` do for OIDC and SAML.
 *
 * CAS defines no `state` parameter of its own, so `state` rides as a query parameter on the `service`
 * URL — CAS preserves a `service`'s existing query string when it appends its own `?ticket=`, so the
 * callback route reads `state` back exactly as it does for a plain OAuth2 provider.
 *
 * `email` is never fabricated out of the bare CAS username: an account is matched or created by an
 * address this module has established belongs to the person (`ProviderProfile` in
 * `models/authentication.ts`). Only CAS 3.0 is offered for the same reason — CAS 1.0 releases no
 * attributes at all, so no address can be established.
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

  /**
   * CAS requires `serviceValidate`'s `service` to match, character for character, the one the ticket
   * was issued against, so both calls build it here. `redirectUri` comes from `callbackUrl()` in
   * `api/auth/provider.ts`, which is why this module needs no administrator-supplied base URL.
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

  /** `ticket`, not `code`, is what the callback route carries back for this protocol. */
  async profile(flowCallback: AuthFlowCallback): Promise<ProviderProfile> {
    if (!this.conf.casUrl) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    if (!flowCallback.ticket) {
      throw new Error('ERR_NO_CAS_TICKET')
    }

    const service = this.serviceUrl(flowCallback.redirectUri, flowCallback.state)
    const url = new URL(`${this.conf.casUrl}/p3/serviceValidate`)
    url.searchParams.set('service', service)
    url.searchParams.set('ticket', flowCallback.ticket)

    let text: string
    try {
      const res = await fetch(url)
      text = await res.text()
    } catch (err: any) {
      CARDINAL.models.flags.authDebug(
        `CAS strategy ${this.strategyId}: serviceValidate request failed: ${err.message}`
      )
      throw new Error('ERR_CAS_LOGIN_FAILED')
    }

    const { username, attrs } = this.parseCas3Response(text)

    const id = firstOf(attrs[this.conf.uniqueIdAttribute]) || username
    const name = firstOf(attrs[this.conf.displayNameAttribute]) || username
    const email = firstOf(attrs[this.conf.emailAttribute])
    if (!email) {
      throw new Error('ERR_NO_EMAIL_FROM_PROVIDER')
    }

    /*
      CAS standardises no separated first/last name the way OIDC has `given_name`/`family_name`, and
      every deployment releases something different, so the halves come from a naive split of `name`
      rather than from an attribute guessed at by convention.
    */
    return { id, email, name, ...splitDisplayName(name) }
  }

  private parseCas3Response(text: string): CasValidation {
    let parsed: any
    try {
      parsed = xmlParser.parse(text)
    } catch (err: any) {
      CARDINAL.models.flags.authDebug(
        `CAS strategy ${this.strategyId}: could not parse the serviceValidate response: ${err.message}`
      )
      throw new Error('ERR_CAS_LOGIN_FAILED')
    }
    const success = parsed?.serviceResponse?.authenticationSuccess
    if (!success?.user) {
      CARDINAL.models.flags.authDebug(
        `CAS strategy ${this.strategyId}: ticket validation failed (CAS 3.0)`
      )
      throw new Error('ERR_CAS_LOGIN_FAILED')
    }
    return { username: `${success.user}`, attrs: success.attributes ?? {} }
  }
}
