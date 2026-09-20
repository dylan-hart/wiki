import { AccountRateLimitedError, limitAuthAttempts } from '../../helpers/rateLimit.ts'
import { recoveryCodeDisplayPattern } from '../../helpers/recoveryCodes.ts'
import { sessionCookieName } from '../../helpers/security.ts'
import type { FastifyInstance } from 'fastify'
import { loginErrorUrl } from './provider.ts'

async function routes(app: FastifyInstance) {
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
      // -> `siteEnabledPreHandler` has already answered 404 for an unknown `:siteId`
      const site = CARDINAL.sites[req.params.siteId]
      // -> `getActiveStrategies`, not the raw rows: it completes each config from the module's
      //    declared defaults, so a prop added after a strategy was configured reads as its default
      const activeStrategies = (await CARDINAL.models.authentication.getActiveStrategies()).filter(
        (str: any) => str.isEnabled
      )
      // -> A site created before it had strategies configured has no list at all
      const configuredStrategies = site.config.authStrategies ?? []
      const siteStrategies = activeStrategies
        .map((str: any) => {
          const authModule = CARDINAL.data.authentication.find((m: any) => m.key === str.module)
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

                Form-based modules only: a redirect-based strategy's new-account path is
                `autoProvision`, which is not the public login screen's business to know about.
              */
              ...(authModule?.useForm && { selfRegistration: str.selfRegistration }),
              // -> A module declaring no such prop reads as false: a strategy with no password of
              //    its own has none to reset
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

  app.put<{
    Params: { siteId: string }
    Body: { strategyId: string; username?: string; password?: string }
  }>(
    '/sites/:siteId/auth/login',
    {
      config: {
        publicAccess: true
      },
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Login',
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          // -> `minLength` only constrains a present value, so without `password` here a body that
          //    omits it would validate
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
        const result = await CARDINAL.models.login.login(
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
          // -> Matches `limitAuthAttempts`' own 429 + `Retry-After` contract, so the IP-keyed and
          //    account-keyed limiters signal exhaustion the same way. Checked before the `ERR_`
          //    branch below, since this error's own message is `ERR_RATE_LIMITED`.
          reply.header('Retry-After', String(err.retryAfter))
          return reply.tooManyRequests(
            `Too many attempts. Try again in ${Math.ceil(err.retryAfter / 60)} minute(s).`
          )
        }
        if (err.message.startsWith('ERR_')) {
          return reply.badRequest(err.message)
        } else {
          // -> The client only gets a generic code, so this line is the one place the cause exists:
          //    hence `error`, not `debug`
          CARDINAL.logger.error('auth', 'login failed unexpectedly', { error: err, reqId: req.id })
          CARDINAL.models.flags.authDebug(`Login failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_LOGIN_FAILED')
        }
      }
    }
  )

  app.post<{
    Params: { siteId: string }
    Body: {
      strategyId: string
      name?: string
      firstName?: string
      lastName?: string
      email: string
      password: string
    }
  }>(
    '/sites/:siteId/auth/register',
    {
      config: {
        publicAccess: true
      },
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Register a new account',
        description:
          "Creates an account under a strategy configured to accept new users. When that strategy's `emailValidation` setting is on (the local strategy's default), the account starts unverified and this answers `nextAction: 'verify'` rather than logging in — a link mailed to the address is what finishes it, at `GET /auth/verify/:token`. With `emailValidation` off, this logs the account straight in like any other successful auth attempt. Submitting an address that already has a verified account under such a strategy answers the same generic `nextAction: 'verify'` rather than an error — that account's owner is emailed a notice instead — so this endpoint cannot be used to test which addresses are already registered.",
        tags: ['Authentication'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['strategyId', 'email', 'password'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            },
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description:
                'An explicitly authored display name. The sign-up form sends the two halves below instead and lets one derive; at least one of the three must produce a non-empty name.'
            },
            firstName: {
              type: 'string',
              maxLength: 255
            },
            lastName: {
              type: 'string',
              maxLength: 255,
              description: 'May be empty - a mononym is a first name with no surname.'
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
        const result = await CARDINAL.models.login.register(
          {
            siteId: req.params.siteId,
            strategyId: req.body.strategyId,
            name: req.body.name,
            firstName: req.body.firstName,
            lastName: req.body.lastName,
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
          CARDINAL.logger.error('auth', 'registration failed unexpectedly', {
            error: err,
            reqId: req.id
          })
          CARDINAL.models.flags.authDebug(`Registration failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_REGISTRATION_FAILED')
        }
      }
    }
  )

  app.put<{
    Params: { siteId: string }
    Body: { strategyId: string; continuationToken: string; newPassword: string }
  }>(
    '/sites/:siteId/auth/changePassword',
    {
      config: {
        publicAccess: true
      },
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
        const result = await CARDINAL.models.login.loginChangePassword(
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
          CARDINAL.models.flags.authDebug(`Password change from login rejected: ${err.message}`)
          return reply.badRequest(err.message)
        } else {
          CARDINAL.logger.error('auth', 'password change from login failed unexpectedly', {
            error: err,
            reqId: req.id
          })
          CARDINAL.models.flags.authDebug(`Password change from login failed: ${err.message}`)
          return reply.badRequest('ERR_CHANGE_PASSWORD_FAILED')
        }
      }
    }
  )

  app.post<{
    Params: { siteId: string }
    Body: { strategyId: string; email: string }
  }>(
    '/sites/:siteId/auth/forgotPassword',
    {
      config: {
        publicAccess: true
      },
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
        await CARDINAL.models.login.forgotPassword({
          strategyId: req.body.strategyId,
          email: req.body.email,
          siteId: req.params.siteId,
          ip: req.ip
        })
      } catch (err: any) {
        // -> Swallowed: even an unexpected failure must be indistinguishable from success, or this
        //    route becomes an oracle for which addresses have accounts
        CARDINAL.logger.error('auth', 'forgot-password request failed unexpectedly', {
          error: err,
          reqId: req.id
        })
        CARDINAL.models.flags.authDebug(
          `Forgot-password request failed unexpectedly: ${err.message}`
        )
      }
      return {
        ok: true,
        message: 'If that address matches an account, a password reset link has been sent to it.'
      }
    }
  )

  /**
   * Unlike the forgot-password request, failures here are reported normally: none of them reveals
   * whether an address has an account.
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
        const result = await CARDINAL.models.login.resetPassword(
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
          CARDINAL.models.flags.authDebug(`Password reset rejected: ${err.message}`)
          return reply.badRequest(err.message)
        } else {
          CARDINAL.logger.error('auth', 'password reset failed unexpectedly', {
            error: err,
            reqId: req.id
          })
          CARDINAL.models.flags.authDebug(`Password reset failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_RESET_PASSWORD_FAILED')
        }
      }
    }
  )

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
        const result = await CARDINAL.models.login.loginTFA(
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
          CARDINAL.models.flags.authDebug(`2FA verification rate-limited: ${err.message}`)
          reply.header('Retry-After', String(err.retryAfter))
          return reply.tooManyRequests(
            `Too many attempts. Try again in ${Math.ceil(err.retryAfter / 60)} minute(s).`
          )
        }
        if (err.message.startsWith('ERR_')) {
          CARDINAL.models.flags.authDebug(`2FA verification rejected: ${err.message}`)
          return reply.badRequest(err.message)
        } else {
          CARDINAL.logger.error('auth', '2FA verification failed unexpectedly', {
            error: err,
            reqId: req.id
          })
          CARDINAL.models.flags.authDebug(`2FA verification failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_TFA_FAILED')
        }
      }
    }
  )

  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/auth/passkey/challenge',
    {
      config: {
        publicAccess: true
      },
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
        const { authOptions, pending } = await CARDINAL.models.passkeys.startLogin({
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
          CARDINAL.logger.error('auth', 'passkey login options failed unexpectedly', {
            error: err,
            reqId: req.id
          })
          return reply.badRequest('ERR_LOGIN_FAILED')
        }
      }
    }
  )

  app.put<{ Params: { siteId: string }; Body: { authResponse: Record<string, any> } }>(
    '/sites/:siteId/auth/passkey/login',
    {
      config: {
        publicAccess: true
      },
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
        const result = await CARDINAL.models.passkeys.verifyLogin(
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
          CARDINAL.logger.error('auth', 'passkey login failed unexpectedly', {
            error: err,
            reqId: req.id
          })
          CARDINAL.models.flags.authDebug(`Passkey login failed unexpectedly: ${err.message}`)
          return reply.badRequest('ERR_LOGIN_FAILED')
        }
      } finally {
        // -> Spent either way: a rejected assertion does not get a second go at the same challenge
        req.session.passkeyLogin = undefined
      }
    }
  )

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
        const { user } = await CARDINAL.models.userCredentials.validateToken({
          kind: 'verify',
          token: req.params.token
        })
        if (!user) {
          return reply.redirect(loginErrorUrl('/', 'ERR_INVALID_VALIDATION_TOKEN'))
        }
        await CARDINAL.models.users.updateUser(user.id, { isVerified: true })
        CARDINAL.models.flags.authDebug(
          `User ${user.id} <${user.email}> verified their email address`
        )
        return reply.redirect('/login?verified=true')
      } catch (err: any) {
        CARDINAL.models.flags.authDebug(`Email verification failed: ${err.message}`)
        return reply.redirect(loginErrorUrl('/', err.message))
      }
    }
  )

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
      const redirect = await CARDINAL.models.login.getLogoutRedirect(
        user?.id ?? null,
        req.params.siteId
      )

      if (req.session) {
        await req.session.destroy()
      }
      // -> `destroy()` detaches the session, which leaves the plugin's own save hook nothing to
      //    clear the cookie with. Name and options must match the registration in
      //    `core/http/session.ts`: the `__Host-` prefix requires even a clearing `Set-Cookie` to
      //    carry `Secure; Path=/`, or the browser rejects it and keeps the stale cookie.
      reply.clearCookie(sessionCookieName(), {
        path: '/',
        secure: CARDINAL.config.security?.cookieSecure !== false,
        sameSite: 'lax'
      })

      if (user) {
        CARDINAL.models.flags.authDebug(
          `User ${user.id} <${user.email}> logged out, redirecting to ${redirect}`
        )
        // -> No site context: `req.params.siteId` is only the login page the user logged out from,
        //    not a scope for the account, and a site-scoped hook must not receive this
        await CARDINAL.models.auditLog.record({
          event: 'user.loggedOut',
          actor: { id: user.id, name: user.name, email: user.email, ip: req.ip },
          targetType: 'user',
          targetId: user.id,
          targetLabel: user.email
        })
        await CARDINAL.models.hooks.emit('user:logout', null, {
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
