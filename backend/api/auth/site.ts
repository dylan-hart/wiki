import { AccountRateLimitedError, limitAuthAttempts } from '../../helpers/rateLimit.ts'
import { recoveryCodeDisplayPattern } from '../../helpers/recoveryCodes.ts'
import { sessionCookieName } from '../../helpers/security.ts'
import type { FastifyInstance } from 'fastify'
import { loginErrorUrl } from './provider.ts'

/**
 * The public, per-site login surface: which strategies a site offers, and everything a reader can do
 * with the local one -- log in, register, change or reset a password, answer a 2FA challenge, use a
 * passkey, verify an email, log out.
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
      // -> `siteEnabledPreHandler` (`helpers/siteResolution.ts`) has already answered 404 for an unknown
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
        const result = await WIKI.models.login.login(
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
        const result = await WIKI.models.login.register(
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
        const result = await WIKI.models.login.loginChangePassword(
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
        await WIKI.models.login.forgotPassword({
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
        const result = await WIKI.models.login.resetPassword(
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
        const result = await WIKI.models.login.loginTFA(
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
        const { user } = await WIKI.models.userCredentials.validateToken({
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
      const redirect = await WIKI.models.login.getLogoutRedirect(
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
}

export default routes
