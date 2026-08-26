import { SAML } from '@node-saml/node-saml'
import { nanoid } from 'nanoid'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/**
 * What `authorizationUrl()` hands back to the `/auth/:strategyId/authorize` route: a URL to redirect to
 * for the HTTP-Redirect binding, or a self-submitting HTML page for the HTTP-POST binding — the
 * AuthnRequest travels as a form POST to the identity provider instead of a query string, which is what
 * `authnRequestBinding` chooses between. Every other module answers with a URL only; this is the one
 * place the route branches on the shape of what came back.
 *
 * `requestId` is the `ID` attribute node-saml generated for the AuthnRequest it just built — see
 * `AuthFlow.requestId` in `models/authentication.ts` for why it has to travel back onto the session.
 */
export type SamlAuthorizationResult =
  | { url: string; requestId: string }
  | { html: string; requestId: string }

/** A SAML attribute value as `@node-saml/node-saml` hands it back: a bare value, or several of them. */
function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return (Array.isArray(value) ? value : [value]).map((v) => `${v}`)
}

/**
 * SAML 2.0
 *
 * A redirect-based module, like OAuth2/OIDC, but neither of `node-saml`'s two building blocks looks
 * like the `openid-client` ones: there is no discovery, no token exchange, and the identity provider's
 * answer is a signed XML assertion delivered as a browser form POST rather than a code on a query
 * string. `RelayState` is where `state` travels for this protocol — see `AuthFlow.state` in
 * `models/authentication.ts` for why, and the POST `/auth/:strategyId/callback` route in
 * `api/authentication.ts` for where it is read back.
 *
 * Every login builds a fresh `SAML` instance from the strategy's stored config rather than keeping one
 * around: unlike OIDC there is no discovery round trip to amortize, and a `NodeSAML` instance is cheap
 * — this way a config change (a rotated certificate, say) takes effect on the very next login with no
 * cache to invalidate.
 */
export default class SamlAuthentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by `models/authentication.ts` right after construction. */
  module?: string

  constructor(strategyId: string, conf: Record<string, any>) {
    this.strategyId = strategyId
    this.conf = conf
  }

  /**
   * Split the "one or more certificates, pipe-separated" convention this field uses (2.5.x's own, kept
   * for the same reason it existed there: a certificate rotation needs the old and new one both
   * accepted for as long as the identity provider is mid-rollover) into what `node-saml` wants — a bare
   * string for one certificate, an array for more than one.
   */
  private static certs(raw: string): string | string[] {
    const parts = raw
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    return parts.length > 1 ? parts : raw
  }

  /**
   * `onRequestId`, when given, is spliced in as node-saml's `generateUniqueId` option — the same hook
   * point the library itself uses to mint the `ID` attribute of an outgoing AuthnRequest — so the id
   * actually used can be captured without a second, throwaway request generation. Only
   * `authorizationUrl()` passes one; `profile()` validates a response rather than building a request,
   * so it never calls `generateUniqueId` at all and gets the library's own default.
   */
  private buildSaml(redirectUri: string, onRequestId?: (id: string) => void): SAML {
    const {
      entryPoint,
      issuer,
      cert,
      audience,
      privateKey,
      decryptionPvk,
      signatureAlgorithm,
      digestAlgorithm,
      identifierFormat,
      wantAssertionsSigned,
      acceptedClockSkewMs,
      disableRequestedAuthnContext,
      authnContext,
      racComparison,
      forceAuthn,
      passive,
      providerName,
      skipRequestCompression,
      authnRequestBinding
    } = this.conf
    if (!entryPoint || !issuer || !cert) {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
    return new SAML({
      callbackUrl: redirectUri,
      entryPoint,
      issuer,
      idpCert: SamlAuthentication.certs(cert),
      audience: audience || false,
      privateKey: privateKey || undefined,
      decryptionPvk: decryptionPvk || undefined,
      signatureAlgorithm: signatureAlgorithm || 'sha256',
      digestAlgorithm: digestAlgorithm || 'sha256',
      identifierFormat: identifierFormat || null,
      wantAssertionsSigned: wantAssertionsSigned ?? true,
      /*
        Not a configurable field — `node-saml` defaults this to `true`, which would refuse any identity
        provider that signs only the assertion and not the response envelope around it. That is the
        common case (Okta and Auth0 both do this by default), and 2.5.x's own field set — the one this
        module matches — never exposed a response-level signing requirement at all, only an
        assertion-level one (`wantAssertionsSigned` above). Leaving this at the library default would be
        a stricter, undocumented behavior change from what an administrator coming from 2.5.x expects.
      */
      wantAuthnResponseSigned: false,
      acceptedClockSkewMs: acceptedClockSkewMs ?? 0,
      disableRequestedAuthnContext: !!disableRequestedAuthnContext,
      authnContext:
        !disableRequestedAuthnContext && authnContext
          ? authnContext
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean)
          : undefined,
      racComparison: racComparison || undefined,
      forceAuthn: !!forceAuthn,
      passive: !!passive,
      providerName: providerName || undefined,
      skipRequestCompression: !!skipRequestCompression,
      authnRequestBinding: authnRequestBinding || 'HTTP-POST',
      generateUniqueId: onRequestId
        ? () => {
            // -> Same shape node-saml's own default produces: a leading underscore so the value is a
            //    valid XML NCName even when nanoid's alphabet would otherwise start with a digit.
            const id = `_${nanoid(40)}`
            onRequestId(id)
            return id
          }
        : undefined
    })
  }

  /**
   * Build the AuthnRequest and hand back how to send the browser off with it.
   *
   * Which of `node-saml`'s two request builders gets called is `authnRequestBinding`, not anything
   * `node-saml` itself decides from its own like-named option (that option only sets a default on the
   * instance; nothing in the library actually reads it back) — so the choice has to be made here, the
   * same way 2.5.x's `passport-saml` strategy made it.
   */
  async authorizationUrl({ redirectUri, state }: AuthFlow): Promise<SamlAuthorizationResult> {
    let requestId = ''
    const saml = this.buildSaml(redirectUri, (id) => {
      requestId = id
    })
    if (this.conf.authnRequestBinding === 'HTTP-Redirect') {
      const url = await saml.getAuthorizeUrlAsync(state, undefined, {})
      return { url, requestId }
    }
    const html = await saml.getAuthorizeFormAsync(state, undefined, {})
    return { html, requestId }
  }

  /**
   * Validate the identity provider's answer and extract who signed in.
   *
   * The response always arrives as a form POST — `AuthFlowCallback.body`, read by the POST callback
   * route — regardless of which binding sent the *request*: a signed assertion is essentially always
   * too large for a redirect's URL length limits, which is why `node-saml` (like the SAML spec itself)
   * only offers redirect-bound validation for logout messages, not login ones; `authnRequestBinding`
   * governs the outbound AuthnRequest only. A callback with no `SAMLResponse` at all — the GET login
   * callback route, which this module has no use for — is refused rather than silently accepted.
   *
   * `validatePostResponseAsync` is where the real checking happens: signature, `audience`, and the
   * clock-skew-bounded validity window (`acceptedClockSkewMs`) are all enforced inside `node-saml`
   * itself before a profile is ever handed back — a tampered assertion, or one whose signature does not
   * chain to `cert`, throws here rather than returning a profile to trust.
   */
  async profile(flowCallback: AuthFlowCallback): Promise<ProviderProfile> {
    if (!flowCallback.body?.SAMLResponse) {
      throw new Error('ERR_NO_SAML_RESPONSE')
    }
    const saml = this.buildSaml(flowCallback.redirectUri)
    const { profile } = await saml.validatePostResponseAsync({
      SAMLResponse: flowCallback.body.SAMLResponse,
      RelayState: flowCallback.body.RelayState
    })
    if (!profile) {
      throw new Error('ERR_SAML_LOGIN_FAILED')
    }

    /*
      Claims are URI-formatted attribute names, not plain keys — `mappingUID`/`mappingEmail`/
      `mappingDisplayName`/`mappingGroups` all hold something like
      `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`, resolved out of the parsed
      assertion's attribute statements. `node-saml` exposes those two ways: flattened onto `profile`
      itself (skipped when the name collides with a profile field it already set, e.g. `email`) and,
      always, under `profile.attributes` keyed by the same claim name — `attributes` is the reliable one
      to read from since it has no such collision to worry about.
    */
    const attrs: Record<string, any> = profile.attributes || {}
    const claim = (name: string): unknown =>
      name ? (attrs[name] !== undefined ? attrs[name] : profile![name]) : undefined

    const id = (firstOf(claim(this.conf.mappingUID)) ?? profile.nameID) as string | undefined
    const email = (firstOf(claim(this.conf.mappingEmail)) ?? profile.email ?? profile.nameID) as
      | string
      | undefined
    const name = firstOf(claim(this.conf.mappingDisplayName)) as string | undefined
    if (!id || !email) {
      throw new Error('ERR_NO_EMAIL_FROM_PROVIDER')
    }

    /*
      `undefined` (not looking) versus `[]` (looked, found nothing) matters to `syncProviderGroups()` —
      see `ProviderProfile.groups`'s own doc comment. A SAML claim reported more than once arrives from
      `node-saml` as an array already (it repeats the `<Attribute>` element rather than comma-joining a
      single value, unlike this framework's LDAP module), so no splitting convention is needed here.
    */
    const groups = this.conf.mapGroups ? asStringArray(claim(this.conf.mappingGroups)) : undefined

    return {
      id: `${id}`,
      email: `${email}`,
      name: name ? `${name}` : `${email}`,
      groups
    }
  }
}
