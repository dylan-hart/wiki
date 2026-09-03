import { nanoid } from 'nanoid'
import { siteIdForHostname } from '../../helpers/siteResolution.ts'
import { limitAuthAttempts } from '../../helpers/rateLimit.ts'
import {
  absoluteRedirectsAllowed,
  isFollowableRedirectTarget
} from '../../helpers/redirectTarget.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * How long a redirect login may take before its callback is refused.
 *
 * Long enough for somebody to be asked for a password and a second factor at the provider, short
 * enough that a `state` left lying around in a URL somewhere is no longer worth anything.
 */
const AUTH_FLOW_MINUTES = 15

/**
 * Where a provider sends the browser back, as an absolute URL.
 *
 * Built from the request rather than stored, so an instance reachable on more than one hostname keeps
 * working — but it has to match what the administrator registered with the provider, which is why the
 * admin area shows this exact shape on the strategy's page.
 */
function callbackUrl(req: FastifyRequest, strategyId: string): string {
  return `${req.protocol}://${req.host}/_api/auth/${strategyId}/callback`
}

/**
 * The login screen, carrying what went wrong.
 *
 * A redirect login fails at the provider or on the way back, where there is no request left to answer
 * with an error — so the browser is sent to the login screen with a code it can put in front of the
 * user, and `redirect` is preserved so that a successful second attempt still lands where the first
 * one was going.
 *
 * Exported for `./site.ts`, whose email-verification route is the one redirect-shaped failure
 * outside this provider flow and answers with the same login-screen error vocabulary.
 */
export function loginErrorUrl(redirect: string, code: string): string {
  const params = new URLSearchParams({ error: code })
  if (redirect && redirect !== '/') {
    params.set('redirect', redirect)
  }
  return `/login?${params.toString()}`
}

/**
 * Carries the redirect a failed callback should land on, alongside the error code — thrown by
 * `matchCallbackFlow()` and caught at each callback route's top level, so neither has to repeat the
 * flow-validation logic to get an error redirect right.
 */
class CallbackFlowError extends Error {
  redirect: string
  code: string

  constructor(redirect: string, code: string) {
    super(code)
    this.redirect = redirect
    this.code = code
  }
}

/**
 * Check an incoming callback against the flow this session started, and consume it — shared by the
 * GET and POST `/auth/:strategyId/callback` routes, which differ only in where `state` and the
 * provider's own error (if any) travel: query string parameters for every OAuth2/OIDC-shaped
 * provider, form fields for SAML. See `AuthFlow.state` in `models/authentication.ts` for how each
 * protocol threads `state` through in the first place.
 *
 * @throws `CallbackFlowError` — `ERR_LOGIN_EXPIRED` for a callback with no matching, unexpired flow
 *         behind it; `ERR_LOGIN_FAILED` when the provider itself reported an error
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
  /*
    Everything about the answer is checked against the flow this session started. A callback that
    arrives with no flow behind it, for another strategy, with a different `state`, or long after the
    login began is not this session's login — and is refused without anything being spent further.
  */
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
    WIKI.models.flags.authDebug(
      `Callback for strategy ${strategyId} from ${req.ip} did not match this session's login`
    )
    req.session.authFlow = undefined
    throw new CallbackFlowError(redirect, 'ERR_LOGIN_EXPIRED')
  }
  // -> Spent, whatever happens next: one callback per login
  req.session.authFlow = undefined

  if (error) {
    WIKI.models.flags.authDebug(
      `Provider refused the login for strategy ${flow.strategyId}: ${error} ${errorDescription ?? ''}`
    )
    throw new CallbackFlowError(redirect, 'ERR_LOGIN_FAILED')
  }

  return { flow, redirect }
}

/**
 * The rest of a callback once its flow has checked out: resolve the profile through the module, then
 * find-or-create and log the account in. Shared by the GET and POST callback routes, which differ only
 * in what they have to hand the module's `profile()` — an authorization `code` and full querystring
 * for GET, the parsed form `body` for POST.
 */
async function finishProviderLogin(
  req: FastifyRequest,
  reply: FastifyReply,
  flow: NonNullable<FastifyRequest['session']['authFlow']>,
  redirect: string,
  extra: { code?: string; ticket?: string; body?: Record<string, any>; currentUrl: string }
) {
  const strategy = await WIKI.models.authentication.getStrategyById(flow.strategyId)
  const instance = WIKI.auth.strategies[flow.strategyId] as any
  if (!strategy?.isEnabled || typeof instance?.profile !== 'function') {
    return reply.redirect(loginErrorUrl(redirect, 'ERR_LOGIN_FAILED'))
  }

  try {
    const profile = await instance.profile({
      redirectUri: callbackUrl(req, strategy.id),
      state: flow.state,
      nonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
      authnRequestId: flow.authnRequestId,
      currentUrl: extra.currentUrl,
      code: extra.code,
      ticket: extra.ticket,
      body: extra.body
    })
    const result = await WIKI.models.login.loginWithProvider(
      { siteId: flow.siteId, strategy, profile, ip: req.ip },
      req
    )
    /*
      `result.redirect` is a group's `redirectOnLogin`/`redirectOnFirstLogin` value (OpenProject
      #1360/#2208, 2026-08-24 security audit) -- validated at write time by `api/groups.ts`'s update
      route, but checked again here as defence in depth against a row written before that validation
      existed (a direct DB write, or a 2.5.x import). `redirect` (the flow's own return path, already
      validated at #1035 below) is the fallback either way.
    */
    const target =
      result.redirect &&
      isFollowableRedirectTarget(result.redirect, { allowAbsolute: absoluteRedirectsAllowed() })
        ? result.redirect
        : redirect
    return reply.redirect(target)
  } catch (err: any) {
    WIKI.models.flags.authDebug(
      `Login through ${strategy.module} strategy ${strategy.id} failed: ${err.message}`
    )
    return reply.redirect(loginErrorUrl(redirect, err.message))
  }
}

/**
 * The external identity-provider login flow: sending a browser off to the provider, and the two
 * shapes of callback it can come back through (a GET redirect, or a SAML POST). The flow state and
 * the error-redirect vocabulary both halves share live here too.
 */
async function routes(app: FastifyInstance) {
  /**
   * START A REDIRECT LOGIN
   */
  app.get<{
    Params: { strategyId: string }
    Querystring: { siteId?: string; redirect?: string }
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
            }
          }
        },
        response: {
          200: {
            description: 'A self-submitting form addressed to the identity provider',
            type: 'string'
          },
          302: { description: 'Redirect to the identity provider', type: 'null' },
          404: { $ref: 'ApiError#', description: 'No such strategy, or it is disabled.' }
        }
      }
    },
    async (req, reply) => {
      const strategy = await WIKI.models.authentication.getStrategyById(req.params.strategyId)
      const instance = WIKI.auth.strategies[req.params.strategyId] as any
      if (!strategy?.isEnabled || typeof instance?.authorizationUrl !== 'function') {
        return reply.notFound('There is no such login provider.')
      }

      // -> `strict`, so an unmatched hostname stays the empty string this has always recorded rather
      //    than becoming the `*` catch-all's id: the flow records which site the login was started
      //    from, and "none identified" is a meaningful answer here
      const siteId = req.query.siteId ?? siteIdForHostname(req.hostname, { strict: true }) ?? ''
      const flow = {
        strategyId: strategy.id,
        siteId,
        state: nanoid(32),
        nonce: nanoid(32),
        codeVerifier: nanoid(64),
        /*
          SAML only: an XML NCName-safe id (must not start with a digit, which `nanoid`'s own
          alphabet does not guarantee) for the outbound AuthnRequest — ignored by every other
          module's `authorizationUrl()`, the same way SAML ignores `nonce`/`codeVerifier`. Generated
          here, ahead of the request being built, so it can be written onto the session first and
          read back by `finishProviderLogin()` below once the identity provider answers — see
          `AuthFlow.authnRequestId` in `models/authentication.ts`.
        */
        authnRequestId: `_${nanoid(40)}`,
        // -> Only a path on this wiki (or, with `security.disallowOpenRedirect` off, a complete
        //    https:// URL): an open redirect is how a login page is turned into a lure, and
        //    `startsWith('/')` alone let `//evil.example` and `/\evil.example` both through, since a
        //    browser resolves either as protocol-relative to whatever host follows (OpenProject
        //    #1360/#2208, 2026-08-24 security audit).
        redirect: isFollowableRedirectTarget(req.query.redirect, {
          allowAbsolute: absoluteRedirectsAllowed()
        })
          ? req.query.redirect!
          : '/',
        startedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
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
        WIKI.models.flags.authDebug(
          `Redirecting to ${strategy.module} provider for strategy ${strategy.id} from ${req.ip}`
        )
        // -> A module answers with a URL to redirect to, or — see `SamlAuthorizationResult` — an HTML
        //    page with a form that submits itself, for a provider whose request has to travel as a POST
        return typeof authorization === 'string'
          ? reply.redirect(authorization)
          : reply.type('text/html').send(authorization.html)
      } catch (err: any) {
        WIKI.logger.warn(`Could not start a login at ${strategy.module}: ${err.message}`)
        return reply.redirect(loginErrorUrl(flow.redirect, err.message))
      }
    }
  )

  /**
   * FINISH A REDIRECT LOGIN
   */
  app.get<{
    Params: { strategyId: string }
    Querystring: {
      code?: string
      /** CAS's equivalent of `code` — see `AuthFlowCallback.ticket` in `models/authentication.ts`. */
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
          "Where the provider sends the browser back. The answer is only accepted if it matches the flow this session started — same strategy, same `state`, and within the time a login takes — after which the module turns the code into an account and the session is established. Ends in a redirect either way: to where the login was heading, or to the login screen carrying an error code.\n\nThis is the URL an administrator registers with the provider; it is shown on the strategy's own page in the admin area.",
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
          return reply.redirect(loginErrorUrl(err.redirect, err.code))
        }
        throw err
      }

      return finishProviderLogin(req, reply, flow, redirect, {
        code: req.query.code,
        ticket: req.query.ticket,
        currentUrl: `${callbackUrl(req, req.params.strategyId)}?${new URLSearchParams(req.query as Record<string, string>).toString()}`
      })
    }
  )

  /**
   * FINISH A REDIRECT LOGIN (FORM POST)
   *
   * The POST counterpart of the callback above, for a provider that answers with a form submission
   * rather than a redirect. SAML is the reason this exists: its response is delivered as a browser POST
   * carrying `SAMLResponse` and `RelayState` — see `AuthFlow.state` in `models/authentication.ts` for
   * why `RelayState` is where `state` travels for SAML specifically, and why CAS needs no equivalent
   * route at all.
   */
  app.post<{
    Params: { strategyId: string }
    Body: { SAMLResponse?: string; RelayState?: string }
  }>(
    '/auth/:strategyId/callback',
    {
      config: {
        publicAccess: true
      },
      // -> A callback is a password check by another name: whatever it carries decides who is logged in
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
          return reply.redirect(loginErrorUrl(err.redirect, err.code))
        }
        throw err
      }

      return finishProviderLogin(req, reply, flow, redirect, {
        body: req.body,
        currentUrl: callbackUrl(req, req.params.strategyId)
      })
    }
  )
}

export default routes
