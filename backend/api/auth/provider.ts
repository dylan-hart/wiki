import { siteIdForHostname } from '../../helpers/siteResolution.ts'
import { limitAuthAttempts } from '../../helpers/rateLimit.ts'
import {
  absoluteRedirectsAllowed,
  isFollowableRedirectTarget
} from '../../helpers/redirectTarget.ts'
import { randomToken } from '../../helpers/randomToken.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ProviderProfile } from '../../models/authentication.ts'

/**
 * Long enough to be asked for a password and a second factor at the provider, short enough that a
 * `state` left lying around in a URL is soon worthless.
 */
const AUTH_FLOW_MINUTES = 15

/**
 * Built from the request rather than stored, so an instance reachable on more than one hostname
 * keeps working. It has to match what the administrator registered with the provider.
 */
function callbackUrl(req: FastifyRequest, strategyId: string): string {
  return `${req.protocol}://${req.host}/_api/auth/${strategyId}/callback`
}

/**
 * A redirect login fails where there is no request left to answer with an error, so the browser is
 * sent to the login screen with a code. `redirect` is preserved so a successful second attempt
 * still lands where the first was going.
 */
export function loginErrorUrl(redirect: string, code: string): string {
  const params = new URLSearchParams({ error: code })
  if (redirect && redirect !== '/') {
    params.set('redirect', redirect)
  }
  return `/login?${params.toString()}`
}

const LINK_RESULT_PARAMS = ['authLink', 'authLinkError', 'strategyId']

/**
 * `redirect` was validated on the way in, but `URL` normalizes what it parses — `/.//evil.example`,
 * `/a/..//evil.example` and `/%2e//evil.example` all come out with a `//evil.example` pathname —
 * so the result is validated again and `/` carries the outcome instead of anything that fails. An
 * absolute target keeps its own origin through the round trip and is otherwise re-checked the same
 * way; whether one may be followed at all was the caller's decision.
 */
export function linkResultUrl(redirect: string, params: Record<string, string>): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(redirect)
  const build = (target: string, keepAbsolute: boolean): string | null => {
    let url: URL
    try {
      url = new URL(target, 'http://link.invalid')
    } catch {
      return null
    }
    for (const key of LINK_RESULT_PARAMS) {
      url.searchParams.delete(key)
    }
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    const result = keepAbsolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`
    return isFollowableRedirectTarget(result, { allowAbsolute: keepAbsolute }) ? result : null
  }
  return build(redirect || '/', absolute) ?? build('/', false)!
}

function errorCode(err: any): string {
  return typeof err?.message === 'string' && /^ERR_[A-Z0-9_]+$/.test(err.message)
    ? err.message
    : 'ERR_LOGIN_FAILED'
}

class CallbackFlowError extends Error {
  redirect: string
  code: string
  link: boolean

  constructor(redirect: string, code: string, link = false) {
    super(code)
    this.redirect = redirect
    this.code = code
    this.link = link
  }
}

function callbackFlowErrorUrl(err: CallbackFlowError): string {
  return err.link
    ? linkResultUrl(err.redirect, { authLinkError: err.code })
    : loginErrorUrl(err.redirect, err.code)
}

/**
 * `state` arrives as a query parameter from an OAuth2/OIDC-shaped provider and as `RelayState` from
 * SAML — see `AuthFlow.state` in `models/authentication.ts`.
 */
function matchCallbackFlow(
  req: FastifyRequest,
  strategyId: string,
  state: string | undefined,
  error?: string,
  errorDescription?: string
): { flow: NonNullable<FastifyRequest['session']['authFlow']>; redirect: string } {
  const flow = req.session.authFlow
  const redirect = flow?.redirect ?? '/'
  const link = flow?.mode === 'link'
  if (
    !flow ||
    flow.strategyId !== strategyId ||
    !state ||
    state !== flow.state ||
    Temporal.Instant.compare(
      Temporal.Instant.from(flow.startedAt).add({ minutes: AUTH_FLOW_MINUTES }),
      Temporal.Now.instant()
    ) < 0
  ) {
    CARDINAL.models.flags.authDebug(
      `Callback for strategy ${strategyId} from ${req.ip} did not match this session's login`
    )
    req.session.authFlow = undefined
    throw new CallbackFlowError(redirect, 'ERR_LOGIN_EXPIRED', link)
  }
  // -> Spent, whatever happens next: one callback per login
  req.session.authFlow = undefined

  if (error) {
    CARDINAL.models.flags.authDebug(
      `Provider refused the login for strategy ${flow.strategyId}: ${error} ${errorDescription ?? ''}`
    )
    throw new CallbackFlowError(redirect, 'ERR_LOGIN_FAILED', link)
  }

  return { flow, redirect }
}

type CallbackExtra = {
  code?: string
  ticket?: string
  body?: Record<string, any>
  currentUrl: string
}

function fetchProviderProfile(
  req: FastifyRequest,
  instance: any,
  strategyId: string,
  flow: NonNullable<FastifyRequest['session']['authFlow']>,
  extra: CallbackExtra
): Promise<ProviderProfile> {
  return instance.profile({
    redirectUri: callbackUrl(req, strategyId),
    state: flow.state,
    nonce: flow.nonce,
    codeVerifier: flow.codeVerifier,
    authnRequestId: flow.authnRequestId,
    currentUrl: extra.currentUrl,
    code: extra.code,
    ticket: extra.ticket,
    body: extra.body
  })
}

async function finishProviderLink(
  req: FastifyRequest,
  reply: FastifyReply,
  flow: NonNullable<FastifyRequest['session']['authFlow']>,
  redirect: string,
  extra: CallbackExtra
) {
  const refuse = (code: string) => reply.redirect(linkResultUrl(redirect, { authLinkError: code }))

  const strategy = await CARDINAL.models.authentication.getStrategyById(flow.strategyId)
  const instance = CARDINAL.auth.strategies[flow.strategyId] as any
  if (!strategy?.isEnabled || typeof instance?.profile !== 'function') {
    return refuse('ERR_LINK_STRATEGY_UNSUPPORTED')
  }

  const userId = req.session.authenticated ? req.session.user?.id : undefined
  if (!userId || !flow.linkUserId || userId !== flow.linkUserId) {
    CARDINAL.models.flags.authDebug(
      `Refused to connect strategy ${strategy.id}: the session is no longer signed in as the user who started it`
    )
    return refuse('ERR_LINK_NOT_SIGNED_IN')
  }

  try {
    const profile = await fetchProviderProfile(req, instance, strategy.id, flow, extra)
    await CARDINAL.models.login.linkProviderToAccount({
      userId,
      strategy,
      profile,
      siteId: flow.siteId,
      ip: req.ip
    })
    return reply.redirect(linkResultUrl(redirect, { authLink: 'added', strategyId: strategy.id }))
  } catch (err: any) {
    CARDINAL.models.flags.authDebug(
      `Connecting ${strategy.module} strategy ${strategy.id} to user ${userId} failed: ${err.message}`
    )
    return refuse(errorCode(err))
  }
}

async function finishProviderLogin(
  req: FastifyRequest,
  reply: FastifyReply,
  flow: NonNullable<FastifyRequest['session']['authFlow']>,
  redirect: string,
  extra: CallbackExtra
) {
  const strategy = await CARDINAL.models.authentication.getStrategyById(flow.strategyId)
  const instance = CARDINAL.auth.strategies[flow.strategyId] as any
  if (!strategy?.isEnabled || typeof instance?.profile !== 'function') {
    return reply.redirect(loginErrorUrl(redirect, 'ERR_LOGIN_FAILED'))
  }

  // -> Outside the `try` so the `catch` can still name whoever the provider said this was
  let profile: ProviderProfile | undefined
  try {
    const resolvedProfile = await fetchProviderProfile(req, instance, strategy.id, flow, extra)
    profile = resolvedProfile
    const result = await CARDINAL.models.login.loginWithProvider(
      { siteId: flow.siteId, strategy, profile: resolvedProfile, ip: req.ip },
      req
    )
    if (result.authenticated && resolvedProfile.idToken) {
      req.session.idpSession = { strategyId: strategy.id, idToken: resolvedProfile.idToken }
    }
    /*
      `result.redirect` is a group's `redirectOnLogin`/`redirectOnFirstLogin`. `api/groups.ts`
      validates it at write time; checked again here as defence in depth against a row written
      another way (a direct DB write, a 2.5.x import). The flow's own `redirect` is validated when
      the login starts.
    */
    const target =
      result.redirect &&
      isFollowableRedirectTarget(result.redirect, { allowAbsolute: absoluteRedirectsAllowed() })
        ? result.redirect
        : redirect
    return reply.redirect(target)
  } catch (err: any) {
    CARDINAL.models.flags.authDebug(
      `Login through ${strategy.module} strategy ${strategy.id} failed: ${err.message}`
    )
    /*
      The one place a failed provider callback reaches the audit log: a `profile()` failure and a
      `loginWithProvider()` refusal both land here. No local user is resolved at this layer, so
      `profile.email` (when the module got that far) is the best identifier there is.
    */
    await CARDINAL.models.auditLog.record({
      event: 'login.failed',
      actor: { id: null, name: profile?.email ?? '', ip: req.ip },
      targetType: 'user',
      targetLabel: profile?.email ?? '',
      detail: { strategyId: strategy.id, reason: err.message },
      siteId: flow.siteId
    })
    return reply.redirect(loginErrorUrl(redirect, err.message))
  }
}

async function linkRefusal(
  req: FastifyRequest,
  strategy: { id: string; isEnabled: boolean } | null | undefined,
  instance: any
): Promise<{ code?: string; userId?: string }> {
  const userId = req.session.authenticated ? req.session.user?.id : undefined
  if (!userId) {
    return { code: 'ERR_LINK_NOT_SIGNED_IN' }
  }
  if (
    !strategy?.isEnabled ||
    typeof instance?.authorizationUrl !== 'function' ||
    typeof instance?.profile !== 'function'
  ) {
    return { code: 'ERR_LINK_STRATEGY_UNSUPPORTED' }
  }
  const user = await CARDINAL.models.users.getById(userId)
  if (!user) {
    return { code: 'ERR_LINK_NOT_SIGNED_IN' }
  }
  if (((user.auth ?? {}) as Record<string, any>)[strategy.id]) {
    return { code: 'ERR_LINK_ALREADY_LINKED' }
  }
  return { userId }
}

async function routes(app: FastifyInstance) {
  app.get<{
    Params: { strategyId: string }
    Querystring: { siteId?: string; redirect?: string; mode?: 'login' | 'link' }
  }>(
    '/auth/:strategyId/authorize',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'Start a login at an identity provider',
        description:
          'Answers with a redirect to the provider, for a strategy whose module signs users in there rather than through a form — OpenID Connect, Google, GitHub. The `state`, `nonce` and PKCE verifier that tie the answer back to this browser are generated here and kept on the session; the browser is never trusted with any of them.\n\nOpened by following the link, not by fetching it: what comes back is a page at the provider, or — for a module whose provider needs its AuthnRequest sent as a form POST rather than a redirect, e.g. a SAML strategy configured for the HTTP-POST binding — a self-submitting HTML form addressed to it.',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          },
          required: ['strategyId']
        },
        querystring: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            redirect: {
              type: 'string',
              maxLength: 255,
              description:
                'Where to send the user once they are logged in. A path on this wiki; anything else is ignored.'
            },
            mode: {
              type: 'string',
              enum: ['login', 'link'],
              default: 'login',
              description:
                "`link` connects the provider to the signed-in account instead of logging anyone in. Every outcome is a redirect to `redirect`, carrying `authLink=added&strategyId=<id>` or `authLinkError=<code>` (`ERR_LINK_STRATEGY_UNSUPPORTED`, `ERR_LINK_NOT_SIGNED_IN`, `ERR_LINK_ALREADY_LINKED`, `ERR_LINK_IDENTITY_IN_USE`, `ERR_EMAIL_NOT_ALLOWED`, or a provider failure's own code)."
            }
          }
        },
        response: {
          200: {
            description: 'A self-submitting form addressed to the identity provider',
            type: 'string'
          },
          302: { description: 'Redirect to the identity provider', type: 'null' },
          403: {
            $ref: 'ApiError#',
            description: 'A `mode=link` start that another site initiated.'
          },
          404: { $ref: 'ApiError#', description: 'No such strategy, or it is disabled.' }
        }
      }
    },
    async (req, reply) => {
      const strategy = await CARDINAL.models.authentication.getStrategyById(req.params.strategyId)
      const instance = CARDINAL.auth.strategies[req.params.strategyId] as any
      const redirect = isFollowableRedirectTarget(req.query.redirect, {
        allowAbsolute: absoluteRedirectsAllowed()
      })
        ? req.query.redirect!
        : '/'

      let linkUserId: string | undefined
      if (req.query.mode === 'link') {
        // -> A connect started from another site is how an attacker gets their own provider
        //    identity bound to a victim's account. An absent header (older browsers) is allowed.
        const fetchSite = req.headers['sec-fetch-site']
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          return reply.forbidden('Cross-origin request blocked')
        }
        const refusal = await linkRefusal(req, strategy, instance)
        if (refusal.code) {
          CARDINAL.models.flags.authDebug(
            `Refused to start connecting strategy ${req.params.strategyId} from ${req.ip}: ${refusal.code}`
          )
          return reply.redirect(linkResultUrl(redirect, { authLinkError: refusal.code }))
        }
        linkUserId = refusal.userId
      }

      if (!strategy?.isEnabled || typeof instance?.authorizationUrl !== 'function') {
        return reply.notFound('There is no such login provider.')
      }

      // -> `strict`: the flow records which site the login was started from, and for an unmatched
      //    hostname "none identified" is the meaningful answer, not the `*` catch-all's id
      const siteId = req.query.siteId ?? siteIdForHostname(req.hostname, { strict: true }) ?? ''
      const flow = {
        strategyId: strategy.id,
        siteId,
        state: randomToken(24),
        nonce: randomToken(24),
        // -> 48 bytes = 64 base64url characters, inside RFC 7636's 43-128 character verifier length
        codeVerifier: randomToken(48),
        // -> SAML only. An XML NCName must not start with a digit, hence the leading `_`. See
        //    `AuthFlow.authnRequestId` in `models/authentication.ts` for why it is generated here.
        authnRequestId: `_${randomToken(30)}`,
        // -> An open redirect is how a login page is turned into a lure
        redirect,
        startedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
        ...(linkUserId ? { mode: 'link' as const, linkUserId } : { mode: 'login' as const })
      }
      req.session.authFlow = flow

      try {
        const authorization = await instance.authorizationUrl({
          redirectUri: callbackUrl(req, strategy.id),
          state: flow.state,
          nonce: flow.nonce,
          codeVerifier: flow.codeVerifier,
          authnRequestId: flow.authnRequestId
        })
        CARDINAL.models.flags.authDebug(
          `Redirecting to ${strategy.module} provider for strategy ${strategy.id} from ${req.ip}`
        )
        // -> A module answers with a URL, or — see `SamlAuthorizationResult` — a self-submitting
        //    HTML form, for a provider whose request has to travel as a POST
        return typeof authorization === 'string'
          ? reply.redirect(authorization)
          : reply.type('text/html').send(authorization.html)
      } catch (err: any) {
        CARDINAL.logger.warn('auth', 'could not start a login at the provider', {
          module: strategy.module,
          strategy: strategy.id,
          error: err
        })
        return reply.redirect(
          linkUserId
            ? linkResultUrl(flow.redirect, { authLinkError: errorCode(err) })
            : loginErrorUrl(flow.redirect, err.message)
        )
      }
    }
  )

  app.get<{
    Params: { strategyId: string }
    Querystring: {
      code?: string
      /** CAS's equivalent of `code`. */
      ticket?: string
      state?: string
      error?: string
      error_description?: string
    }
  }>(
    '/auth/:strategyId/callback',
    {
      config: {
        publicAccess: true
      },
      // -> A callback is a password check by another name: whatever it carries decides who is logged in
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Finish a login at an identity provider',
        description:
          "Where the provider sends the browser back. The answer is only accepted if it matches the flow this session started — same strategy, same `state`, and within the time a login takes — after which the module turns the code into an account and the session is established. Ends in a redirect either way: to where the login was heading, or to the login screen carrying an error code.\n\nA flow started with `mode=link` never logs anyone in: it connects the provider to the account that started it, provided the session is still signed in as that account, and redirects back to where it started with `authLink` or `authLinkError`.\n\nThis is the URL an administrator registers with the provider; it is shown on the strategy's own page in the admin area.",
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          },
          required: ['strategyId']
        },
        response: {
          302: { description: 'Redirect back into the wiki', type: 'null' }
        }
      }
    },
    async (req, reply) => {
      let flow: NonNullable<FastifyRequest['session']['authFlow']>
      let redirect: string
      try {
        ;({ flow, redirect } = matchCallbackFlow(
          req,
          req.params.strategyId,
          req.query.state,
          req.query.error,
          req.query.error_description
        ))
      } catch (err: any) {
        if (err instanceof CallbackFlowError) {
          return reply.redirect(callbackFlowErrorUrl(err))
        }
        throw err
      }

      const finish = flow.mode === 'link' ? finishProviderLink : finishProviderLogin
      return finish(req, reply, flow, redirect, {
        code: req.query.code,
        ticket: req.query.ticket,
        currentUrl: `${callbackUrl(req, req.params.strategyId)}?${new URLSearchParams(req.query as Record<string, string>).toString()}`
      })
    }
  )

  app.post<{
    Params: { strategyId: string }
    Body: { SAMLResponse?: string; RelayState?: string }
  }>(
    '/auth/:strategyId/callback',
    {
      config: {
        publicAccess: true
      },
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Finish a login at an identity provider (form POST)',
        description:
          'Where a provider that answers with a browser form POST — SAML — sends the browser back, `SAMLResponse` and `RelayState` included. Otherwise identical to the GET callback: the same flow-matching, expiry and `state` checks apply, with `state` read from `RelayState` here instead of a query parameter.',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          },
          required: ['strategyId']
        },
        body: {
          type: 'object',
          properties: {
            SAMLResponse: { type: 'string' },
            RelayState: { type: 'string' }
          }
        },
        response: {
          302: { description: 'Redirect back into the wiki', type: 'null' }
        }
      }
    },
    async (req, reply) => {
      let flow: NonNullable<FastifyRequest['session']['authFlow']>
      let redirect: string
      try {
        ;({ flow, redirect } = matchCallbackFlow(req, req.params.strategyId, req.body?.RelayState))
      } catch (err: any) {
        if (err instanceof CallbackFlowError) {
          return reply.redirect(callbackFlowErrorUrl(err))
        }
        throw err
      }

      const finish = flow.mode === 'link' ? finishProviderLink : finishProviderLogin
      return finish(req, reply, flow, redirect, {
        body: req.body,
        currentUrl: callbackUrl(req, req.params.strategyId)
      })
    }
  )

  app.get<{
    Params: { strategyId: string }
  }>(
    '/auth/:strategyId/metadata',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'Fetch the service provider metadata of a login provider',
        description:
          "The XML an identity provider's administrator imports to register this wiki — entity ID, assertion consumer service URL and public certificates. Only a strategy whose module has service provider metadata to give (SAML) answers; every other case, including a strategy that is disabled or misconfigured, is the same 404.\n\nThe consumer service URL is built from the request's own host, so fetch it at the address the identity provider will reach the wiki on.",
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          },
          required: ['strategyId']
        },
        response: {
          200: {
            description: 'SAML service provider metadata',
            type: 'string'
          },
          404: {
            $ref: 'ApiError#',
            description: 'No such strategy, or it has no metadata to give.'
          }
        }
      }
    },
    async (req, reply) => {
      const strategy = await CARDINAL.models.authentication.getStrategyById(req.params.strategyId)
      const instance = CARDINAL.auth.strategies[req.params.strategyId] as any
      if (!strategy?.isEnabled || typeof instance?.metadata !== 'function') {
        return reply.notFound('There is no such login provider.')
      }

      try {
        const xml: string = instance.metadata(callbackUrl(req, strategy.id))
        return reply.type('application/samlmetadata+xml; charset=utf-8').send(xml)
      } catch (err: any) {
        if (err?.message !== 'ERR_STRATEGY_MISCONFIGURED') {
          throw err
        }
        CARDINAL.logger.warn('auth', 'could not build service provider metadata', {
          module: strategy.module,
          strategy: strategy.id,
          error: err
        })
        return reply.notFound('There is no such login provider.')
      }
    }
  )
}

export default routes
