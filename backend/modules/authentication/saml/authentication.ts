import { SAML, ValidateInResponseTo } from '@node-saml/node-saml'
import type { CacheProvider } from '@node-saml/node-saml'
import type { AuthFlow, AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'
import { providerNameHalves } from '../../../models/authentication.ts'

/**
 * Fixed rather than exposed as mapping props the way `mappingUID`/`mappingEmail`/
 * `mappingDisplayName` are: these are the standard WS-Federation/SAML claim types every identity
 * provider that issues a separated name at all emits. One that issues neither leaves both halves
 * empty, which is what a mononym or a display-name-only directory already looks like.
 */
const GIVEN_NAME_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'
const SURNAME_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'

/**
 * Caps the identity provider's own `NotOnOrAfter` rather than trusting a compromised or
 * misconfigured one unconditionally: `@node-saml/node-saml` defaults `maxAssertionAgeMs` to `0`, so
 * `NotOnOrAfter` is otherwise the only bound. Matches `AUTH_FLOW_MINUTES` in `api/auth/provider.ts`
 * — an assertion older than a login flow may itself take has no reason to still be circulating.
 */
const MAX_ASSERTION_AGE_MS = 15 * 60 * 1000

/**
 * `validateInResponseTo` wants a replay cache, but `buildSaml()` constructs a fresh `SAML` instance
 * per request, so anything in-memory — the library's own `InMemoryCacheProvider` included — would
 * already be gone by the time the callback is validated, single-process deployment or not.
 *
 * What ties the two requests together instead is the DB-backed `req.session.authFlow`:
 * `authorizationUrl()` pins the AuthnRequest's `ID` to an id generated ahead of it, and `profile()`
 * is handed that same id back. So this provider holds no state of its own and answers about nothing
 * but the one id it was bound to.
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
 * A plain URL for the HTTP-Redirect binding, or a self-submitting HTML page for HTTP-POST, where the
 * AuthnRequest travels as a form POST rather than a query string. Every other module answers with a
 * URL only, so `/auth/:strategyId/authorize` branches on the shape for this one alone.
 */
export type SamlAuthorizationResult = string | { html: string }

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
 * Redirect-based like OAuth2/OIDC, but with no discovery and no token exchange: the identity
 * provider's answer is a signed XML assertion delivered as a browser form POST rather than a code on
 * a query string, and `RelayState` is where `state` travels for this protocol.
 *
 * Every login builds a fresh `SAML` instance from the strategy's stored config rather than keeping
 * one around: there is no discovery round trip to amortize, and this way a rotated certificate takes
 * effect on the very next login with no cache to invalidate.
 *
 * `node-saml` never validates a `SubjectConfirmationData`'s `Recipient` against `callbackUrl` under
 * any setting, so with `wantAuthnResponseSigned` pinned `false` below, `audience` and `InResponseTo`
 * are the only two things binding a given assertion to this SP and this specific login.
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
   * `cert` takes one or more certificates pipe-separated, so a rotation can have the old and the new
   * one both accepted while the identity provider is mid-rollover. `node-saml` wants a bare string
   * for one and an array for several.
   */
  private static certs(raw: string): string | string[] {
    const parts = raw
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    return parts.length > 1 ? parts : raw
  }

  /**
   * @param authnRequestId Round-tripped through `req.session.authFlow` — see
   *   `singleRequestCacheProvider`. Absent only for a strategy-validation call that never reaches the
   *   identity provider.
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
        Falls back to this SP's own entity ID -- `node-saml`'s own default when unset -- rather than
        `false`, which skips `AudienceRestriction` validation entirely: see the class doc on why
        `audience` is one of only two assertion-scope bindings this stack has. `issuer` is required
        above, so this is never itself falsy.
      */
      audience: audience || issuer,
      privateKey: privateKey || undefined,
      decryptionPvk: decryptionPvk || undefined,
      signatureAlgorithm: signatureAlgorithm || 'sha256',
      digestAlgorithm: digestAlgorithm || 'sha256',
      identifierFormat: identifierFormat || null,
      wantAssertionsSigned: wantAssertionsSigned ?? true,
      /*
        Not a configurable field. `node-saml` defaults it to `true`, which refuses any identity
        provider that signs only the assertion and not the response envelope around it -- the common
        case, Okta and Auth0 both among them. Assertion-level signing is what `wantAssertionsSigned`
        above requires instead.
      */
      wantAuthnResponseSigned: false,
      acceptedClockSkewMs: acceptedClockSkewMs ?? 0,
      /*
        Not a configurable field: there is no legitimate reason to turn replay protection off, and
        what backs it is `singleRequestCacheProvider`, not an administrator-facing knob.
      */
      validateInResponseTo: ValidateInResponseTo.always,
      cacheProvider: singleRequestCacheProvider(authnRequestId),
      /*
        Consulted only while building an outbound AuthnRequest: pins the request's `ID` to the value
        already generated and recorded on the session, rather than letting `node-saml` invent one
        nobody has a record of. `undefined` falls back to the library's own generator, for
        `profile()`, which has no request to build and so no id to pin.
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

  metadata(redirectUri: string): string {
    const { privateKey, decryptionPvk, signingCert, decryptionCert } = this.conf
    const saml = new SamlAuthentication(this.strategyId, {
      ...this.conf,
      privateKey: signingCert ? privateKey : undefined,
      decryptionPvk: decryptionCert ? decryptionPvk : undefined
    }).buildSaml(redirectUri)
    return saml.generateServiceProviderMetadata(
      decryptionCert || null,
      signingCert ? SamlAuthentication.certs(signingCert) : null
    )
  }

  /**
   * Which of `node-saml`'s two request builders runs has to be decided here: the library's own
   * like-named `authnRequestBinding` option only sets a default on the instance, and nothing inside
   * it reads that back.
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
   * The response always arrives as a form POST regardless of which binding sent the *request*: a
   * signed assertion is essentially always too large for a redirect's URL length limits, which is why
   * `node-saml` (like the SAML spec) offers redirect-bound validation for logout messages only.
   * `authnRequestBinding` governs the outbound AuthnRequest alone.
   *
   * `validatePostResponseAsync` is where the real checking happens — signature, `audience`, the
   * clock-skew-bounded validity window, and `InResponseTo` against the AuthnRequest this exact login
   * sent — all inside `node-saml`, which throws rather than handing back a profile to trust.
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
      Claims are URI-formatted attribute names, not plain keys, so `mappingUID`/`mappingEmail`/
      `mappingDisplayName`/`mappingGroups` each hold something like
      `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`. `node-saml` exposes them
      flattened onto `profile` (skipped where the name collides with a field it already set, e.g.
      `email`) and, always, under `profile.attributes` — the latter has no such collision, so it wins.
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
      A claim reported more than once arrives from `node-saml` as an array already — it repeats the
      `<Attribute>` element rather than comma-joining a single value — so no splitting convention is
      needed here. `undefined` versus `[]` is the distinction `syncProviderGroups()` reads.
    */
    const groups = this.conf.mapGroups ? asStringArray(claim(this.conf.mappingGroups)) : undefined
    // -> No `NameID` fallback, unlike `id`/`email` above: nothing on the assertion itself is ever a
    //    picture URL. Absent rather than '' when unmapped, per `ProviderProfile.picture`.
    const picture = this.conf.mappingPicture
      ? (firstOf(claim(this.conf.mappingPicture)) as string | undefined)
      : undefined

    return {
      id: `${id}`,
      email: `${email}`,
      name: name ? `${name}` : `${email}`,
      ...providerNameHalves(firstOf(claim(GIVEN_NAME_CLAIM)), firstOf(claim(SURNAME_CLAIM))),
      groups,
      picture: picture ? `${picture}` : undefined
    }
  }
}
