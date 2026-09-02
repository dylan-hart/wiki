import { nanoid } from 'nanoid'
import { siteIdForHostname } from '../helpers/siteResolution.ts'
import { AccountRateLimitedError, limitAuthAttempts } from '../helpers/rateLimit.ts'
import { recoveryCodeDisplayPattern } from '../helpers/recoveryCodes.ts'
import { absoluteRedirectsAllowed, isFollowableRedirectTarget } from '../helpers/redirectTarget.ts'
import { sessionCookieName } from '../helpers/security.ts'
import { actorFromRequest } from '../models/auditLog.ts'
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
 */
function loginErrorUrl(redirect: string, code: string): string {
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
    const result = await WIKI.models.users.loginWithProvider(
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
 * Authentication API Routes
 */
async function routes(app: FastifyInstance) {
  /**
   * GET SITE AUTHENTICATION STRATEGIES
   */
  app.get<{ Params: { siteId: string }; Querystring: { visibleOnly?: boolean } }>(
    '/sites/:siteId/auth/strategies',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'List all site authentication strategies',
        description:
          'Ordered by the position configured for the site. `activeStrategy` holds the per-instance settings, nested under it `strategy` holds the module definition.',
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            visibleOnly: {
              type: 'boolean',
              default: false
            }
          }
        },
        response: {
          200: {
            description: 'List of site authentication strategies',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  format: 'uuid'
                },
                order: {
                  type: 'integer'
                },
                isVisible: {
                  type: 'boolean'
                },
                activeStrategy: {
                  type: 'object',
                  properties: {
                    displayName: {
                      type: 'string'
                    },
                    selfRegistration: {
                      type: 'boolean',
                      description:
                        'Present only for a form-based strategy — whether it accepts a new self-registered account. Omitted for a redirect-based strategy: that kind is provisioned automatically or not at all, never through this public self-registration flag.'
                    },
                    allowForgotPassword: {
                      type: 'boolean',
                      description:
                        'Whether this strategy offers a password reset from the login screen. False for a strategy whose module has no such setting.'
                    },
                    strategy: {
                      type: 'object',
                      properties: {
                        key: {
                          type: 'string'
                        },
                        title: {
                          type: 'string'
                        },
                        icon: {
                          type: 'string'
                        },
                        color: {
                          type: 'string'
                        },
                        useForm: {
                          type: 'boolean'
                        },
                        usernameType: {
                          type: 'string'
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      // -> `siteEnabledPreHandler` (`helpers/common.ts`) has already answered 404 for an unknown
      //    `:siteId` before any handler here runs, so this is the site, not a maybe —
      //    `models/sites.ts#getSiteById` is this same map lookup with an `await` in front of it.
      const site = WIKI.sites[req.params.siteId]
      /*
        `getActiveStrategies` rather than the raw rows: it completes each config from the module's
        declared defaults, so a prop added to a module after a strategy was configured reads as its
        default here instead of as a missing key.
      */
      const activeStrategies = (await WIKI.models.authentication.getActiveStrategies()).filter(
        (str: any) => str.isEnabled
      )
      // -> A site created before it had strategies configured has no list at all
      const configuredStrategies = site.config.authStrategies ?? []
      const siteStrategies = activeStrategies
        .map((str: any) => {
          const authModule = WIKI.data.authentication.find((m: any) => m.key === str.module)
          const siteStr = configuredStrategies.find((s: any) => s.id === str.id) || {}
          return {
            id: str.id,
            order: siteStr.order ?? 0,
            isVisible: siteStr.isVisible ?? false,
            activeStrategy: {
              displayName: str.displayName,
              /*
                Named explicitly, like every other field here: this endpoint is public and a strategy's
                config is where an OAuth client secret lives, so nothing may reach it by spreading.

                Only ever present for a form-based module: a redirect-based strategy's new-account path
                is `autoProvision`, which is never the public login screen's business to know about --
                publishing it unauthenticated is exactly what told an attacker which provider currently
                accepts a self-registration POST (see `models/users.ts#register()`'s `useForm` check).
              */
              ...(authModule?.useForm && { selfRegistration: str.selfRegistration }),
              /*
                A module that declares no such prop reads as false, which is correct rather than a
                default -- a strategy with no password of its own has no password to reset.
              */
              allowForgotPassword: str.config?.allowForgotPassword === true,
              strategy: {
                key: authModule?.key ?? str.module,
                title: authModule?.title ?? str.module,
                icon: authModule?.icon ?? '',
                color: authModule?.color ?? 'primary',
                useForm: authModule?.useForm ?? false,
                usernameType: authModule?.usernameType ?? 'email'
              }
            }
          }
        })
        .sort((a: any, b: any) => a.order - b.order)
      return req.query.visibleOnly ? siteStrategies.filter((s: any) => s.isVisible) : siteStrategies
    }
  )

  /**
   * LOGIN USING USER/PASS
   */
  app.put<{
    Params: { siteId: string }
    Body: { strategyId: string; username?: string; password?: string }
  }>(
    '/sites/:siteId/auth/login',
    {
      config: {
        publicAccess: true
      },
      // -> Guessing is what this endpoint is attacked with; see `helpers/rateLimit.ts`
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Login',
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          // -> `password` is required here too, not just checked deeper in `users.login()`: an
          //    omitted key skips `minLength`'s check entirely (it only constrains a *present*
          //    value), so without this a body of `{ strategyId, username }` validated and reached
          //    the LDAP strategy with `password: undefined`.
          required: ['strategyId', 'password'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            },
            username: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            password: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            }
          }
        },
        response: {
          200: { $ref: 'AuthLoginResult#' },
          400: { $ref: 'ApiError#' },
          429: {
            $ref: 'ApiError#',
            description:
              'The account-keyed rate limit was exceeded (see `helpers/rateLimit.ts#consumeAccountAuthAttempt`).'
          }
        }
      }
    },
    async (req, reply) => {
      try {
        const result = await WIKI.models.users.login(
          {
            siteId: req.params.siteId,
            strategyId: req.body.strategyId,
            username: req.body.username,
            password: req.body.password,
            ip: req.ip
          },
          req
        )
        if (!result) {
          throw new Error('Unexpected empty login response.')
        }
        return {
          ok: true,
          ...result
        }
      } catch (err: any) {
        if (err instanceof AccountRateLimitedError) {
          // -> Matches `limitAuthAttempts`' own 429 + `Retry-After` contract, so the two rate
          //    limiters guarding this endpoint (IP-keyed and account-keyed) signal exhaustion the
          //    same way to API clients (OpenProject #2361). Checked before the generic `ERR_`-prefix
          //    branch below, since this error's own message is still `ERR_RATE_LIMITED`.
          reply.header('Retry-After', String(err.retryAfter))
          return reply.tooManyRequests(
            `Too many attempts. Try again in ${Math.ceil(err.retryAfter / 60)} minute(s).`
          )
        }
        if (err.message.startsWith('ERR_')) {
          return reply.badRequest(err.message)
        } else {
          // -> An unexpected failure, reported to the client as a generic one. The detail is behind
          //    the authDebug flag rather than logged on every failed login.
          WIKI.logger.debug(err)
          WIKI.models.flags.authDebug(`Login failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_LOGIN_FAILED')
        }
      }
    }
  )

  /**
   * SELF-REGISTER
   */
  app.post<{
    Params: { siteId: string }
    Body: { strategyId: string; name: string; email: string; password: string }
  }>(
    '/sites/:siteId/auth/register',
    {
      config: {
        publicAccess: true
      },
      // -> Same reasoning as login: a form anyone can submit is what this endpoint is attacked with
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Register a new account',
        description:
          "Creates an account under a strategy configured to accept new users. When that strategy's `emailValidation` setting is on (the local strategy's default), the account starts unverified and this answers `nextAction: 'verify'` rather than logging in — a link mailed to the address is what finishes it, at `GET /auth/verify/:token`. With `emailValidation` off, this logs the account straight in like any other successful auth attempt. Submitting an address that already has a verified account under such a strategy answers the same generic `nextAction: 'verify'` rather than an error — that account's owner is emailed a notice instead — so this endpoint cannot be used to test which addresses are already registered.",
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['strategyId', 'name', 'email', 'password'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            },
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            email: {
              type: 'string',
              format: 'email',
              maxLength: 255
            },
            password: {
              type: 'string',
              minLength: 8,
              maxLength: 255
            }
          }
        },
        response: {
          200: { $ref: 'AuthLoginResult#' }
        }
      }
    },
    async (req, reply) => {
      try {
        const result = await WIKI.models.users.register(
          {
            siteId: req.params.siteId,
            strategyId: req.body.strategyId,
            name: req.body.name,
            email: req.body.email,
            password: req.body.password,
            ip: req.ip
          },
          req
        )
        return {
          ok: true,
          ...result
        }
      } catch (err: any) {
        if (err.message.startsWith('ERR_')) {
          return reply.badRequest(err.message)
        } else {
          // -> An unexpected failure, reported to the client as a generic one, matching the login route
          WIKI.logger.debug(err)
          WIKI.models.flags.authDebug(`Registration failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_REGISTRATION_FAILED')
        }
      }
    }
  )

  /**
   * CHANGE PASSWORD
   */
  app.put<{
    Params: { siteId: string }
    Body: { strategyId: string; continuationToken: string; newPassword: string }
  }>(
    '/sites/:siteId/auth/changePassword',
    {
      config: {
        publicAccess: true
      },
      // -> Guessing is what this endpoint is attacked with; see `helpers/rateLimit.ts`
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Change Password From Login',
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['strategyId', 'continuationToken', 'newPassword'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            },
            continuationToken: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            newPassword: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            }
          }
        },
        response: {
          200: { $ref: 'AuthLoginResult#' },
          400: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      try {
        const result = await WIKI.models.users.loginChangePassword(
          {
            siteId: req.params.siteId,
            strategyId: req.body.strategyId,
            continuationToken: req.body.continuationToken,
            newPassword: req.body.newPassword,
            ip: req.ip
          },
          req
        )
        if (!result) {
          throw new Error('Unexpected empty change password response.')
        }
        if (result?.authenticated) {
          req.session.authenticated = true
        }
        return {
          ok: true,
          ...result
        }
      } catch (err: any) {
        if (err.message.startsWith('ERR_')) {
          WIKI.models.flags.authDebug(`Password change from login rejected: ${err.message}`)
          return reply.badRequest(err.message)
        } else {
          WIKI.logger.debug(err)
          WIKI.models.flags.authDebug(`Password change from login failed: ${err.message}`)
          return reply.badRequest('ERR_CHANGE_PASSWORD_FAILED')
        }
      }
    }
  )

  /**
   * REQUEST A PASSWORD RESET
   *
   * Always answers the same generic success, whatever `forgotPassword()` did behind it -- an unknown
   * strategy, one with password resets turned off, an address matching no account, and an address that
   * does match are all indistinguishable from the outside. Anything but that fixed shape would make
   * this endpoint an oracle for which addresses have accounts, which is the one thing a "forgot
   * password" form must never leak.
   */
  app.post<{
    Params: { siteId: string }
    Body: { strategyId: string; email: string }
  }>(
    '/sites/:siteId/auth/forgotPassword',
    {
      config: {
        publicAccess: true
      },
      // -> Guessing addresses is what this endpoint is attacked with; see `helpers/rateLimit.ts`
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Request a password reset email',
        description:
          "Always answers the same generic success, regardless of whether `email` matches an account or the strategy allows resets at all -- so this can never be used to test whether an address has an account. When it does match, and the strategy's `allowForgotPassword` setting is on, a link is mailed to it pointing at `PUT /sites/:siteId/auth/resetPassword`.",
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['strategyId', 'email'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            },
            email: {
              type: 'string',
              format: 'email',
              maxLength: 255
            }
          }
        },
        response: {
          200: { $ref: 'AuthForgotPasswordResult#' }
        }
      }
    },
    async (req) => {
      try {
        await WIKI.models.users.forgotPassword({
          strategyId: req.body.strategyId,
          email: req.body.email
        })
      } catch (err: any) {
        // -> Swallowed rather than reported: even an unexpected failure here must not produce a
        //    response distinguishable from the success case, or it becomes the oracle this route
        //    exists to avoid being.
        WIKI.logger.debug(err)
        WIKI.models.flags.authDebug(`Forgot-password request failed unexpectedly: ${err.message}`)
      }
      return {
        ok: true,
        message: 'If that address matches an account, a password reset link has been sent to it.'
      }
    }
  )

  /**
   * RESET PASSWORD
   *
   * Where the link mailed by `forgotPassword` above points. Unlike that request step, failures here
   * are reported normally -- a bad or expired token, or too short a password -- since none of them
   * reveal whether any particular address has an account.
   */
  app.put<{
    Params: { siteId: string }
    Body: { strategyId: string; token: string; newPassword: string }
  }>(
    '/sites/:siteId/auth/resetPassword',
    {
      config: {
        publicAccess: true
      },
      // -> Guessing is what this endpoint is attacked with; see `helpers/rateLimit.ts`
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Finish a password reset from the forgot-password email',
        description:
          'Sets the new password and, on success, logs the account straight in -- like every other token-continuation flow in this file -- except that 2FA is still required first when the account has it active, since a mailed reset token alone never proves a second factor was checked.',
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['strategyId', 'token', 'newPassword'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            },
            token: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            newPassword: {
              type: 'string',
              minLength: 8,
              maxLength: 255
            }
          }
        },
        response: {
          200: { $ref: 'AuthLoginResult#' }
        }
      }
    },
    async (req, reply) => {
      try {
        const result = await WIKI.models.users.resetPassword(
          {
            siteId: req.params.siteId,
            strategyId: req.body.strategyId,
            token: req.body.token,
            newPassword: req.body.newPassword,
            ip: req.ip
          },
          req
        )
        if (!result) {
          throw new Error('Unexpected empty reset password response.')
        }
        if (result?.authenticated) {
          req.session.authenticated = true
        }
        return {
          ok: true,
          ...result
        }
      } catch (err: any) {
        if (err.message.startsWith('ERR_')) {
          WIKI.models.flags.authDebug(`Password reset rejected: ${err.message}`)
          return reply.badRequest(err.message)
        } else {
          WIKI.logger.debug(err)
          WIKI.models.flags.authDebug(`Password reset failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_RESET_PASSWORD_FAILED')
        }
      }
    }
  )

  /**
   * SUBMIT A 2FA CODE
   *
   * The other half of a login that answered `provideTfa` or `setupTfa`: the continuation token stands
   * for the login that got that far, and the code proves the second factor. With `setup`, a correct
   * code also activates the secret the login generated, which is how an account that is required to
   * use 2FA gets it configured.
   */
  app.put<{
    Params: { siteId: string }
    Body: {
      strategyId: string
      continuationToken: string
      securityCode: string
      setup?: boolean
    }
  }>(
    '/sites/:siteId/auth/tfa',
    {
      config: {
        publicAccess: true
      },
      // -> Guessing is what this endpoint is attacked with; see `helpers/rateLimit.ts`
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Submit a 2FA Security Code From Login',
        description:
          'Answers like the login route does, since the same checks continue afterwards: a user who also owes a password change is asked for one next. A wrong code can be retried a few times before the continuation token is discarded and the login has to be started again.',
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['strategyId', 'continuationToken', 'securityCode'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            },
            continuationToken: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            securityCode: {
              type: 'string',
              pattern: `^([0-9]{6}|${recoveryCodeDisplayPattern})$`,
              description:
                'Either the six digits shown by the authenticator app, or one of the account’s recovery codes (`XXXX-XXXX-XXXX-XXXX`). A recovery code cannot answer a `setup` submission — that flow only proves a freshly-generated authenticator secret works, before any recovery codes exist for it.'
            },
            setup: {
              type: 'boolean',
              default: false,
              description:
                'True when answering a `setupTfa` login, i.e. the code confirms a secret that was just generated.'
            }
          }
        },
        response: {
          200: { $ref: 'AuthLoginResult#' },
          400: { $ref: 'ApiError#' },
          429: {
            $ref: 'ApiError#',
            description:
              'The account-keyed rate limit was exceeded (see `helpers/rateLimit.ts#consumeAccountAuthAttempt`).'
          }
        }
      }
    },
    async (req, reply) => {
      try {
        const result = await WIKI.models.users.loginTFA(
          {
            siteId: req.params.siteId,
            strategyId: req.body.strategyId,
            continuationToken: req.body.continuationToken,
            securityCode: req.body.securityCode,
            setup: req.body.setup ?? false,
            ip: req.ip
          },
          req
        )
        return {
          ok: true,
          ...result
        }
      } catch (err: any) {
        if (err instanceof AccountRateLimitedError) {
          // -> See the login route's own comment above (OpenProject #2361): matches
          //    `limitAuthAttempts`' 429 + `Retry-After` contract instead of falling through to the
          //    generic `ERR_`-prefix 400 branch below.
          WIKI.models.flags.authDebug(`2FA verification rate-limited: ${err.message}`)
          reply.header('Retry-After', String(err.retryAfter))
          return reply.tooManyRequests(
            `Too many attempts. Try again in ${Math.ceil(err.retryAfter / 60)} minute(s).`
          )
        }
        if (err.message.startsWith('ERR_')) {
          WIKI.models.flags.authDebug(`2FA verification rejected: ${err.message}`)
          return reply.badRequest(err.message)
        } else {
          WIKI.logger.debug(err)
          WIKI.models.flags.authDebug(`2FA verification failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_TFA_FAILED')
        }
      }
    }
  )

  /**
   * REQUEST A PASSKEY CHALLENGE
   *
   * Takes no identity: a passkey says which account it belongs to, so there is nobody to name until the
   * assertion comes back. The challenge is remembered on the session.
   */
  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/auth/passkey/challenge',
    {
      config: {
        publicAccess: true
      },
      // -> Guessing is what this endpoint is attacked with; see `helpers/rateLimit.ts`
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Get the options for logging in with a passkey',
        description:
          "Pass the result to the browser's WebAuthn API, then send what the authenticator produces to `PUT /sites/:siteId/auth/passkey/login`. No credential list is sent and no user is named: passkeys are registered as discoverable credentials, so the authenticator offers whichever ones it holds for this hostname and the assertion identifies the account.",
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Passkey challenge generated',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              authOptions: {
                type: 'object',
                additionalProperties: true,
                description: 'A WebAuthn `PublicKeyCredentialRequestOptions`, JSON-encoded.'
              }
            }
          },
          400: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      try {
        const { authOptions, pending } = await WIKI.models.passkeys.startLogin({
          hostname: req.hostname,
          origin: req.headers.origin
        })
        req.session.passkeyLogin = pending
        return {
          ok: true,
          authOptions
        }
      } catch (err: any) {
        if (err.message.startsWith('ERR_')) {
          return reply.badRequest(err.message)
        } else {
          WIKI.logger.debug(err)
          return reply.badRequest('ERR_LOGIN_FAILED')
        }
      }
    }
  )

  /**
   * LOGIN USING A PASSKEY
   */
  app.put<{ Params: { siteId: string }; Body: { authResponse: Record<string, any> } }>(
    '/sites/:siteId/auth/passkey/login',
    {
      config: {
        publicAccess: true
      },
      // -> Guessing is what this endpoint is attacked with; see `helpers/rateLimit.ts`
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Login With a Passkey',
        description:
          'Verifies what the authenticator signed and, if it holds up, logs the user in. A passkey establishes both identity and presence, so no password or 2FA code is asked for on top of it.',
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['authResponse'],
          properties: {
            authResponse: {
              type: 'object',
              additionalProperties: true,
              description: "The browser's WebAuthn authentication response, JSON-encoded."
            }
          }
        },
        response: {
          200: { $ref: 'AuthLoginResult#' },
          400: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      try {
        const result = await WIKI.models.passkeys.verifyLogin(
          {
            authResponse: req.body.authResponse as any,
            pending: req.session.passkeyLogin,
            ip: req.ip
          },
          req
        )
        return {
          ok: true,
          ...result
        }
      } catch (err: any) {
        if (err.message.startsWith('ERR_')) {
          return reply.badRequest(err.message)
        } else {
          WIKI.logger.debug(err)
          WIKI.models.flags.authDebug(`Passkey login failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_LOGIN_FAILED')
        }
      } finally {
        // -> Spent either way: a rejected assertion does not get a second go at the same challenge
        req.session.passkeyLogin = undefined
      }
    }
  )

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

  /**
   * VERIFY EMAIL ADDRESS
   */
  app.get<{ Params: { token: string } }>(
    '/auth/verify/:token',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'Verify an email address from a self-registration link',
        description:
          'Where the link mailed by `POST /sites/:siteId/auth/register` points. Marks the account verified and redirects to the login screen — carrying `verified=true` on success, or an error code the same way a provider login redirect does, on an invalid or expired token.',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            token: {
              type: 'string'
            }
          },
          required: ['token']
        },
        response: {
          302: { description: 'Redirect to the login screen', type: 'null' }
        }
      }
    },
    async (req, reply) => {
      try {
        const { user } = await WIKI.models.users.validateToken({
          kind: 'verify',
          token: req.params.token
        })
        if (!user) {
          return reply.redirect(loginErrorUrl('/', 'ERR_INVALID_VALIDATION_TOKEN'))
        }
        await WIKI.models.users.updateUser(user.id, { isVerified: true })
        WIKI.models.flags.authDebug(`User ${user.id} <${user.email}> verified their email address`)
        return reply.redirect('/login?verified=true')
      } catch (err: any) {
        WIKI.models.flags.authDebug(`Email verification failed: ${err.message}`)
        return reply.redirect(loginErrorUrl('/', err.message))
      }
    }
  )

  /**
   * LOGOUT
   */
  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/auth/logout',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'Logout',
        description:
          "Destroys the current session and answers with where to send the user next: the first of the user's groups that sets a logout redirect, otherwise the site's own setting, otherwise the site root. A request that was not logged in gets the same answer rather than an error, so that a client acting on a session the server has already forgotten still ends up somewhere sensible.",
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Logged out successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              redirect: {
                type: 'string',
                description: 'A path within this wiki, or an absolute URL if one is configured.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const user = req.session?.authenticated ? req.session.user : null

      // -> Resolved before the session goes away, since it depends on who was logged in
      const redirect = await WIKI.models.users.getLogoutRedirect(
        user?.id ?? null,
        req.params.siteId
      )

      if (req.session) {
        // -> Drops the stored session, so the cookie the browser still holds refers to nothing
        await req.session.destroy()
      }
      // -> And clear that cookie too: `destroy()` detaches the session, which leaves the plugin's own
      //    save hook with nothing to do. Name and options match the registration in `index.ts`: the
      //    `__Host-` prefix requires a clearing `Set-Cookie` to still carry `Secure; Path=/` (task
      //    2109 / WP 2105 §2) or the browser rejects the clear the same way it would a real one,
      //    leaving the stale (now-orphaned) cookie sitting in the browser -- `security.cookieSecure:
      //    false` drops both, so the clear has to match whichever is actually in effect. `sameSite`
      //    also mirrors the registration ('lax', not 'strict' -- see index.ts's comment: the
      //    OAuth/SAML callback is a cross-site top-level navigation back to this origin) so the
      //    clearing cookie's attributes match the one being cleared exactly (OpenProject #2336).
      reply.clearCookie(sessionCookieName(), {
        path: '/',
        secure: WIKI.config.security?.cookieSecure !== false,
        sameSite: 'lax'
      })

      if (user) {
        WIKI.models.flags.authDebug(
          `User ${user.id} <${user.email}> logged out, redirecting to ${redirect}`
        )
        // -> No site context: `req.params.siteId` names which site's login page the user happened to
        //    log out from, not a business site scope for the account -- same reasoning as
        //    `user:join`/`user:login` in `models/users.ts`. A site-scoped hook must not receive this.
        await WIKI.models.hooks.emit('user:logout', null, {
          userId: user.id,
          ip: req.ip,
          metadata: {
            name: user.name,
            email: user.email
          }
        })
      }

      return {
        ok: true,
        redirect
      }
    }
  )

  /**
   * LIST AUTHENTICATION MODULES
   */
  app.get(
    '/authentication/modules',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the authentication modules available on this server',
        description:
          'Read from `modules/authentication` at startup, so installing a module means dropping it on disk and restarting. Modules that declare themselves unavailable are not listed.',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'List of authentication modules',
            type: 'array',
            items: { $ref: 'AuthModule#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return WIKI.models.authentication.getModules()
    }
  )

  /**
   * LIST CONFIGURED STRATEGIES
   */
  app.get(
    '/authentication/strategies',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the configured authentication strategies',
        description:
          'Instance-wide, i.e. every strategy regardless of which sites offer it. Which of them a given site shows on its login screen, and in what order, is part of that site’s configuration. Configuration values include any secrets a module stores, hence the `manage:system` requirement.',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'List of configured strategies',
            type: 'array',
            items: { $ref: 'AuthStrategy#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return WIKI.models.authentication.getActiveStrategies({ mask: true })
    }
  )

  /**
   * GET CONFIGURED STRATEGY
   */
  app.get<{ Params: { strategyId: string } }>(
    '/authentication/strategies/:strategyId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get a single configured authentication strategy',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['strategyId']
        },
        response: {
          200: { $ref: 'AuthStrategy#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const strategy = await WIKI.models.authentication.getStrategyById(req.params.strategyId, {
        mask: true
      })
      if (!strategy) {
        return reply.notFound('Authentication strategy does not exist.')
      }
      return strategy
    }
  )

  /**
   * CREATE STRATEGY
   */
  app.post<{ Body: Record<string, any> }>(
    '/authentication/strategies',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Configure a new authentication strategy',
        description:
          'A module can be configured more than once, so that two instances of the same provider can coexist. A new strategy is not offered by any site until that site adds it to its login screen.',
        tags: ['Authentication'],
        body: {
          allOf: [{ $ref: 'AuthStrategyInput#' }, { type: 'object', required: ['module'] }]
        },
        response: {
          200: {
            description: 'Strategy created successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              id: {
                type: 'string',
                format: 'uuid'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const mod = WIKI.models.authentication.getModule(req.body.module)
      if (!mod) {
        return reply.badRequest('ERR_UNKNOWN_AUTH_MODULE')
      }

      const invalid =
        (await WIKI.models.authentication.validateStrategy({
          module: req.body.module,
          displayName: req.body.displayName,
          isEnabled: req.body.isEnabled,
          allowedEmailRegex: req.body.allowedEmailRegex,
          autoEnrollGroups: req.body.autoEnrollGroups,
          mappableGroups: req.body.mappableGroups
        })) ?? WIKI.models.authentication.validateConfig(req.body.module, req.body.config)
      if (invalid) {
        return reply.badRequest(invalid)
      }

      const id = await WIKI.models.authentication.createStrategy(req.body as any)

      return {
        ok: true,
        message: 'Authentication strategy created successfully.',
        id
      }
    }
  )

  /**
   * UPDATE STRATEGY
   */
  app.put<{ Params: { strategyId: string }; Body: Record<string, any> }>(
    '/authentication/strategies/:strategyId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update an authentication strategy',
        description:
          'Accepts any subset of the fields, except `module`, which is fixed once a strategy exists. The strategies are reloaded on success, so a configuration change applies to the next login rather than after a restart.',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['strategyId']
        },
        body: { $ref: 'AuthStrategyInput#' },
        response: {
          200: {
            description: 'Strategy updated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The strategy update could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const current = await WIKI.models.authentication.getStrategyById(req.params.strategyId)
      if (!current) {
        return reply.notFound('Authentication strategy does not exist.')
      }
      if (req.body.module !== undefined && req.body.module !== current.module) {
        return reply.badRequest('The module of an existing strategy cannot be changed.')
      }

      const patch: Record<string, any> = {}
      for (const field of [
        'displayName',
        'isEnabled',
        'selfRegistration',
        'autoProvision',
        'allowedEmailRegex',
        'autoEnrollGroups',
        'trustEmailForLinking',
        'mappableGroups',
        'config'
      ] as const) {
        if (req.body[field] !== undefined) {
          patch[field] = req.body[field]
        }
      }
      if (Object.keys(patch).length < 1) {
        return reply.badRequest('No strategy fields provided to update.')
      }

      const invalid =
        (await WIKI.models.authentication.validateStrategy({
          id: current.id,
          module: current.module,
          ...patch
        })) ?? WIKI.models.authentication.validateConfig(current.module, patch.config)
      if (invalid) {
        return reply.badRequest(invalid)
      }

      if (!(await WIKI.models.authentication.updateStrategy(req.params.strategyId, patch))) {
        return reply.internalServerError('Failed to update the authentication strategy.')
      }

      // -> Config holds OAuth client secrets and LDAP bind passwords, so `detail` names which
      //    top-level fields changed rather than their values -- `changedFields` never descends into
      //    `patch.config` itself. Mirrors `storage.targetUpdated` in `api/storage.ts`.
      await WIKI.models.auditLog.record({
        event: 'auth.strategyUpdated',
        actor: actorFromRequest(req),
        targetType: 'authStrategy',
        targetId: current.id,
        targetLabel: current.displayName,
        detail: { module: current.module, changedFields: Object.keys(patch) }
      })

      return {
        ok: true,
        message: 'Authentication strategy updated successfully.'
      }
    }
  )

  /**
   * DELETE STRATEGY
   */
  app.delete<{ Params: { strategyId: string } }>(
    '/authentication/strategies/:strategyId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Delete an authentication strategy',
        description:
          'Also removes it from every site’s login screen. The built-in local strategy cannot be deleted: every account stores its password under that strategy ID, so removing it would leave no way in.',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['strategyId']
        },
        response: {
          204: {
            description: 'Strategy deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description: 'The built-in local strategy cannot be deleted.'
          }
        }
      }
    },
    async (req, reply) => {
      const strategy = await WIKI.models.authentication.getStrategyById(req.params.strategyId)
      if (!strategy) {
        return reply.notFound('Authentication strategy does not exist.')
      }
      if (strategy.id === WIKI.data.systemIds.localAuthId) {
        return reply.conflict('The built-in local strategy cannot be deleted.')
      }

      await WIKI.models.authentication.deleteStrategy(req.params.strategyId)
      return reply.code(204).send()
    }
  )
}

export default routes
