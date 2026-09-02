import { SAML, ValidateInResponseTo } from '@node-saml/node-saml'
import type { CacheProvider } from '@node-saml/node-saml'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/**
 * How long after its `IssueInstant` an assertion may still be accepted, capping the identity
 * provider's own `NotOnOrAfter` rather than trusting a compromised or misconfigured one
 * unconditionally — `@node-saml/node-saml` defaults `maxAssertionAgeMs` to `0`, i.e. no cap beyond
 * `NotOnOrAfter` itself (`saml.js`'s `calcMaxAgeAssertionTime`). Matches `AUTH_FLOW_MINUTES` in
 * `api/auth/provider.ts`: an assertion issued further in the past than a login flow is itself
 * allowed to take has no legitimate reason to still be circulating.
 */
const MAX_ASSERTION_AGE_MS = 15 * 60 * 1000

/**
 * `@node-saml/node-saml`'s cache-provider abstraction, standing in for the real replay cache
 * `validateInResponseTo` needs. The library's own default (`InMemoryCacheProvider`) says outright
 * that it is not sufficient across multiple server instances — and it could not work here regardless,
 * since `buildSaml()` constructs a fresh `SAML` instance per request (see the class doc comment): an
 * in-memory cache populated while building the outbound AuthnRequest would already be gone by the time
 * an unrelated later instance validates the callback, single-process deployment or not.
 *
 * What actually ties the two requests together is `req.session.authFlow`, which is DB-backed
 * (`models/sessions.ts`) and therefore survives both of those. `authorizationUrl()` below pins the
 * AuthnRequest's own `ID` to a value generated ahead of time (`api/auth/provider.ts`'s
 * `/auth/:strategyId/authorize` route) rather than letting `node-saml` invent one nobody records, and
 * `profile()` is handed that same id back once the session flow is read. This provider does nothing
 * but compare against the one id it was bound to at construction time — it holds no state of its own
 * and answers about nothing else.
 */
function singleRequestCacheProvider(expectedId: string | undefined): CacheProvider {
  return {
    async saveAsync(_key, value) {
      return { createdAt: Date.now(), value }
    },
    async getAsync(key) {
      return expectedId && key === expectedId ? key : null
    },
    async removeAsync(key) {
      return expectedId && key === expectedId ? key : null
    }
  }
}

/**
 * What `authorizationUrl()` hands back to the `/auth/:strategyId/authorize` route: a plain string for
 * the HTTP-Redirect binding (the browser is redirected straight to it), or a self-submitting HTML page
 * for the HTTP-POST binding — the AuthnRequest travels as a form POST to the identity provider instead
 * of a query string, which is what `authnRequestBinding` chooses between. Every other module answers
 * with a URL only; this is the one place the route branches on the shape of what came back.
 */
export type SamlAuthorizationResult = string | { html: string }

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
 * `api/auth/provider.ts` for where it is read back.
 *
 * Every login builds a fresh `SAML` instance from the strategy's stored config rather than keeping one
 * around: unlike OIDC there is no discovery round trip to amortize, and a `NodeSAML` instance is cheap
 * — this way a config change (a rotated certificate, say) takes effect on the very next login with no
 * cache to invalidate. `buildSaml()`'s `singleRequestCacheProvider` is what lets that per-request
 * instance still enforce `validateInResponseTo` despite never persisting anything of its own.
 *
 * `node-saml` never validates a `SubjectConfirmationData`'s `Recipient` against `callbackUrl` under
 * any setting (there is nothing in `saml.js` that reads it), so with `wantAuthnResponseSigned` pinned
 * `false` below, `audience` and `InResponseTo` are the only two things binding a given assertion to
 * this SP and this specific login — see `buildSaml()`'s `audience` and `validateInResponseTo` options.
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
   * @param authnRequestId The id `authorizationUrl()` generated for the outbound AuthnRequest this
   *   login is tied to, round-tripped through `req.session.authFlow` — see
   *   `singleRequestCacheProvider`. Absent when there is no flow to bind to yet, which only ever
   *   happens for a strategy-validation call that never reaches the identity provider.
   */
  private buildSaml(redirectUri: string, authnRequestId?: string): SAML {
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
      /*
        Falls back to this SP's own entity ID -- `node-saml`'s own default when unset
        (`ctorOptions.audience ?? ctorOptions.issuer`, `saml.js:78`) -- rather than `false`, which
        used to skip `AudienceRestriction` validation entirely: see the class doc comment on why
        `audience` is the only assertion-scope binding this stack has at all, now that this no longer
        goes silently unenforced by default. `issuer` is required above, so this is never itself
        falsy.
      */
      audience: audience || issuer,
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
      /*
        Not a configurable field, same reasoning as `wantAuthnResponseSigned` above: this needs a
        real replay cache to be worth anything (see `singleRequestCacheProvider`) rather than an
        administrator-facing knob, and there is no legitimate reason to ever turn it off.
      */
      validateInResponseTo: ValidateInResponseTo.always,
      cacheProvider: singleRequestCacheProvider(authnRequestId),
      /*
        Only consulted while building an outbound AuthnRequest (`generateAuthorizeRequestAsync`):
        pins the request's `ID` to the value `authorizationUrl()`'s caller already generated and
        recorded on the session, rather than letting `node-saml` invent one nobody has a record of.
        `undefined` here just falls back to `node-saml`'s own generator, for the one caller
        (`profile()`, validating a response) that has no request left to build and so no id to pin.
      */
      generateUniqueId: authnRequestId ? () => authnRequestId : undefined,
      maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
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
      authnRequestBinding: authnRequestBinding || 'HTTP-POST'
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
  async authorizationUrl({
    redirectUri,
    state,
    authnRequestId
  }: AuthFlow): Promise<SamlAuthorizationResult> {
    const saml = this.buildSaml(redirectUri, authnRequestId)
    if (this.conf.authnRequestBinding === 'HTTP-Redirect') {
      return saml.getAuthorizeUrlAsync(state, undefined, {})
    }
    return { html: await saml.getAuthorizeFormAsync(state, undefined, {}) }
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
   * `validatePostResponseAsync` is where the real checking happens: signature, `audience`, the
   * clock-skew-bounded validity window (`acceptedClockSkewMs`), and — since `flowCallback.authnRequestId`
   * is threaded into `buildSaml()` the same way `authorizationUrl()` threaded it in — the response's
   * `InResponseTo` against the AuthnRequest this exact login sent, are all enforced inside `node-saml`
   * itself before a profile is ever handed back — a tampered assertion, one whose signature does not
   * chain to `cert`, or a `SAMLResponse` replayed against a different login than the one that requested
   * it, all throw here rather than returning a profile to trust.
   */
  async profile(flowCallback: AuthFlowCallback): Promise<ProviderProfile> {
    if (!flowCallback.body?.SAMLResponse) {
      throw new Error('ERR_NO_SAML_RESPONSE')
    }
    const saml = this.buildSaml(flowCallback.redirectUri, flowCallback.authnRequestId)
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
