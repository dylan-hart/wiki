import type { FastifyInstance, FastifyRequest } from 'fastify'
import { CustomError, rethrowAsBadRequest } from '../../helpers/common.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import {
  deriveDisplayName,
  forcedPublicFields,
  PROFILE_PUBLIC_FIELDS,
  type ProfilePublicField,
  type UserPatch
} from '../../models/users.ts'
import { sessionUserIdOrNull } from './profile.ts'

interface UserUpdateBody {
  name?: string
  firstName?: string
  lastName?: string
  email?: string
  isActive?: boolean
  isVerified?: boolean
  meta?: Record<string, any>
  prefs?: Record<string, any>
  groups?: string[]
  auth?: Record<string, any>
}

/**
 * What blocks `DELETE /:userId` on a `23503`, keyed by the Postgres constraint name so the 409 can
 * name the actual relation. `remedy` is the reassign advice only for what `reassignContent()`
 * clears; `pageEditSubmissions.authorId` has no reassign path.
 */
const DELETE_USER_BLOCKING_RELATIONS: Record<string, { relation: string; remedy: string }> = {
  pages_authorId_users_id_fkey: { relation: 'authored pages', remedy: 'Reassign them first.' },
  pages_creatorId_users_id_fkey: { relation: 'created pages', remedy: 'Reassign them first.' },
  pages_ownerId_users_id_fkey: { relation: 'owned pages', remedy: 'Reassign them first.' },
  assets_authorId_users_id_fkey: { relation: 'authored assets', remedy: 'Reassign them first.' },
  pageEditSubmissions_authorId_users_id_fkey: {
    relation: 'an open page edit suggestion',
    remedy: 'Approve or reject it first.'
  }
}

/**
 * Exported because `bootstrap` answers the same question as part of the one call an app load makes.
 *
 * The profile preferences are re-read from the `users` table on every call rather than served from
 * the session's login-time snapshot: a profile save only refreshes the session that made it, so
 * another device would keep serving what it had at login. The snapshot remains the fallback when
 * the account row is already gone.
 */
export async function whoAmI(req: FastifyRequest): Promise<Record<string, any>> {
  if (!req.session?.authenticated) {
    return { authenticated: false }
  }
  const profile = req.session.user?.id
    ? await CARDINAL.models.users.getProfile(req.session.user.id)
    : null
  return {
    authenticated: true,
    ...req.session.user,
    ...(profile && {
      timezone: profile.timezone,
      dateFormat: profile.dateFormat,
      timeFormat: profile.timeFormat,
      appearance: profile.appearance,
      aesthetic: profile.aesthetic,
      contentWidth: profile.contentWidth,
      cvd: profile.cvd,
      locale: profile.locale,
      graph: profile.graph,
      iconPicker: profile.iconPicker,
      searchFilters: profile.searchFilters
    }),
    /*
      The same list the route permission hook checks. Nothing is added for the interface's benefit: a
      control shown on a permission the session does not hold gets a 403 from the endpoint behind it.
    */
    permissions: req.session.permissions ?? []
  }
}

/**
 * `manage:users` is deliberately short of the root: an administrator who can rename, re-group, reset
 * the password of, or delete a `manage:system` account can take the instance over through it.
 */
async function systemUserGuard(req: FastifyRequest, userId: string): Promise<CustomError | null> {
  if (CARDINAL.models.groups.holdsSystemPermission(req)) {
    return null
  }
  if (!(await CARDINAL.models.groups.userHoldsSystemPermission(userId))) {
    return null
  }
  return new CustomError(
    'userSystemProtected',
    'This user belongs to a group with the manage:system permission. Only a user who holds manage:system can modify them.',
    403
  )
}

/**
 * Every route here declares `config.permissions` except `GET /whoami`, which answers about the
 * caller themselves.
 */
async function routes(app: FastifyInstance) {
  app.get<{
    // -> Non-optional: the schema's `default` fills a missing `page`/`limit` ahead of the handler
    Querystring: { page: number; limit: number; filter?: string; assignableToGroupId?: string }
  }>(
    '/',
    {
      config: {
        permissions: ['read:users', 'manage:users']
      },
      schema: {
        summary: 'List all users',
        tags: ['Users'],
        querystring: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description: 'Matched against the user name and email, case-insensitively.',
              maxLength: 255
            },
            assignableToGroupId: {
              type: 'string',
              format: 'uuid',
              description:
                'Keep only the users that may be assigned to this group, i.e. omit its current members and any system user. Intended for pickers offering users to assign.'
            },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
          }
        },
        response: {
          200: {
            description: 'List of Users',
            type: 'object',
            properties: {
              page: { type: 'integer' },
              limit: { type: 'integer' },
              total: { type: 'integer' },
              users: {
                type: 'array',
                items: { $ref: 'UserCore#' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const { page, limit } = req.query
      const { total, users } = await CARDINAL.models.users.getUsers({
        filter: req.query.filter ?? '',
        assignableToGroupId: req.query.assignableToGroupId ?? '',
        page,
        limit
      })
      return { page, limit, total, users }
    }
  )

  // -> Non-optional: the schema's `default` fills a missing `limit` ahead of the handler
  app.get<{ Querystring: { limit: number } }>(
    '/recent-logins',
    {
      config: {
        // -> `access:admin`, not `read:users`: this fills a panel on the admin dashboard, which
        //    everyone who can open the admin area sees. It is why the answer is identity plus a
        //    timestamp and nothing else -- every account flag still needs `read:users`.
        permissions: ['access:admin']
      },
      schema: {
        summary: 'List the most recent logins',
        description:
          'Who signed in last, most recent first. Accounts that have never logged in are left out rather than trailing the list, as are system accounts — nothing signs in as the guest.',
        tags: ['Users'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
          }
        },
        response: {
          200: {
            description: 'The most recent logins, newest first',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                email: { type: 'string' },
                lastLoginAt: {
                  type: 'string',
                  format: 'date-time',
                  description: 'RFC 3339 Date Time'
                }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.users.getRecentLogins({ limit: req.query.limit })
    }
  )

  app.get(
    '/fallback-accounts',
    {
      config: {
        permissions: ['read:users', 'manage:users']
      },
      schema: {
        summary: 'List migrated provider-fallback accounts pending a password reset',
        description:
          'Every account the migration importer created through the local strategy in place of a provider it could not link (`migratedFallbackProvider`) that has not yet relinked via SSO (`mustChangePwd` still `true`). Oldest-created first.',
        tags: ['Users'],
        response: {
          200: {
            description: 'The pending fallback accounts',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                email: { type: 'string' },
                providerKey: {
                  type: 'string',
                  description: 'The original 2.x providerKey this account was migrated from.'
                },
                createdAt: {
                  type: 'string',
                  format: 'date-time',
                  description: 'RFC 3339 Date Time'
                }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return CARDINAL.models.users.getFallbackAccounts()
    }
  )

  app.get(
    '/whoami',
    {
      schema: {
        summary: 'Get currently logged in user info',
        description:
          'Includes the group-wide permissions of the session, which is what the interface hides its own controls by. Permissions ON A PAGE are a different question, answered by `pages/userPermissions`.\n\nThe app itself gets this from `bootstrap` on load, together with the site and the flags; this endpoint is what asks again once a login or a logout has changed the answer.',
        tags: ['Users'],
        response: {
          200: {
            description:
              '`{ authenticated: false }` for a guest. A logged in session also includes the profile fields carried on the session, plus the flattened permissions its groups grant.',
            allOf: [
              {
                type: 'object',
                properties: {
                  authenticated: { type: 'boolean' },
                  permissions: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'The same list the route permission hook checks against, from the groups this user belongs to.'
                  }
                }
              },
              { $ref: 'UserProfile#' }
            ]
          }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      return await whoAmI(req)
    }
  )

  app.get(
    '/defaults',
    {
      config: {
        permissions: ['read:users', 'manage:users']
      },
      schema: {
        summary: 'Get the defaults applied to new users',
        tags: ['Users'],
        response: {
          200: {
            description: 'User defaults',
            type: 'object',
            $ref: 'UserDefaults#'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return CARDINAL.config.userDefaults
    }
  )

  app.put<{ Body: { timezone?: string; dateFormat?: string; timeFormat?: string } }>(
    '/defaults',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: 'Update the defaults applied to new users',
        description:
          'These are instance-wide, not per-site. Existing users keep their own preferences.',
        tags: ['Users'],
        body: {
          $ref: 'UserDefaults#'
        },
        response: {
          200: {
            description: 'User defaults updated successfully',
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
          500: { $ref: 'ApiError#', description: 'The user defaults could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      // -> A bad time zone would break every date the affected users see, and the list of valid
      //    zones is only known at runtime, so it cannot be expressed as a schema enum
      if (req.body.timezone !== undefined) {
        if (!Intl.supportedValuesOf('timeZone').includes(req.body.timezone)) {
          throw new CustomError(
            'userDefaultsInvalidTimezone',
            `Not a recognized IANA time zone: ${req.body.timezone}`
          )
        }
      }

      const patch: Record<string, any> = {}
      for (const key of ['timezone', 'dateFormat', 'timeFormat'] as const) {
        if (req.body[key] !== undefined) {
          patch[key] = req.body[key]
        }
      }
      if (Object.keys(patch).length < 1) {
        throw new CustomError('userDefaultsEmpty', 'No user defaults provided to update.')
      }

      const previousDefaults = CARDINAL.config.userDefaults
      CARDINAL.config.userDefaults = { ...previousDefaults, ...patch }

      if (!(await CARDINAL.configSvc.saveToDb(['userDefaults']))) {
        CARDINAL.config.userDefaults = previousDefaults
        return reply.internalServerError('Failed to save user defaults.')
      }

      return {
        ok: true,
        message: 'User defaults updated successfully.'
      }
    }
  )

  app.get(
    '/profile-visibility',
    {
      config: {
        permissions: ['read:users', 'manage:users']
      },
      schema: {
        summary: 'Get the instance-wide profile visibility settings',
        tags: ['Users'],
        response: {
          200: {
            description: 'Profile visibility settings',
            type: 'object',
            $ref: 'ProfileVisibility#'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return {
        forcedPublicFields: forcedPublicFields(),
        guestsMayView: CARDINAL.config.profileVisibility?.guestsMayView === true
      }
    }
  )

  app.put<{ Body: { forcedPublicFields?: ProfilePublicField[]; guestsMayView?: boolean } }>(
    '/profile-visibility',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: 'Update the instance-wide profile visibility settings',
        description:
          'These are instance-wide, not per-site, because the public profile endpoint is not site-scoped. Any subset may be sent; omitted ones are left unchanged.',
        tags: ['Users'],
        body: {
          $ref: 'ProfileVisibility#'
        },
        response: {
          200: {
            description: 'Profile visibility settings updated successfully',
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
          500: { $ref: 'ApiError#', description: 'The settings could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const patch: Record<string, any> = {}
      if (req.body.forcedPublicFields !== undefined) {
        patch.forcedPublicFields = PROFILE_PUBLIC_FIELDS.filter((field) =>
          req.body.forcedPublicFields!.includes(field)
        )
      }
      if (req.body.guestsMayView !== undefined) {
        patch.guestsMayView = req.body.guestsMayView
      }
      if (Object.keys(patch).length < 1) {
        throw new CustomError('profileVisibilityEmpty', 'No profile visibility settings provided.')
      }

      const previous = CARDINAL.config.profileVisibility
      CARDINAL.config.profileVisibility = { ...previous, ...patch }

      if (!(await CARDINAL.configSvc.saveToDb(['profileVisibility']))) {
        CARDINAL.config.profileVisibility = previous
        return reply.internalServerError('Failed to save profile visibility settings.')
      }

      return {
        ok: true,
        message: 'Profile visibility settings updated successfully.'
      }
    }
  )

  app.get<{ Params: { userId: string } }>(
    '/:userId',
    {
      config: {
        permissions: ['read:users', 'manage:users']
      },
      schema: {
        summary: 'Get user info',
        description:
          'Returns the user with its group membership and linked authentication providers.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['userId']
        },
        response: {
          200: {
            description: 'User info',
            type: 'object',
            $ref: 'User#'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const user = await CARDINAL.models.users.getUserDetail(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }
      return user
    }
  )

  app.post<{
    Body: {
      name?: string
      firstName?: string
      lastName?: string
      email: string
      password: string
      groups?: string[]
      mustChangePassword?: boolean
      sendWelcomeEmail?: boolean
      sendWelcomeEmailFromSiteId?: string
    }
  }>(
    '/',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: 'Create a new user',
        description:
          'Creates a user authenticated against the local strategy. Send `firstName`/`lastName` — the two authored halves the admin-create form collects — and the display name derives from them; sending `name` instead authors it directly. At least one of the two must produce a non-empty display name. When `sendWelcomeEmail` is set, the new user is emailed a link to set their own password instead of being told it directly — this requires a configured mail transport (Admin > Mail Configuration), or the request is refused before the user is created. `sendWelcomeEmailFromSiteId` picks which site the link is built against; omitted, it falls back to the instance-wide default base URL.',
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description:
                'An explicitly authored display name. Omit it to let one derive from the two halves below, which is what the admin-create form does.'
            },
            firstName: {
              type: 'string',
              maxLength: 255
            },
            lastName: {
              type: 'string',
              maxLength: 255,
              description: 'May be empty — a mononym is a first name with no surname.'
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
            },
            groups: {
              type: 'array',
              items: {
                type: 'string',
                format: 'uuid'
              }
            },
            mustChangePassword: {
              type: 'boolean',
              default: false
            },
            sendWelcomeEmail: {
              type: 'boolean',
              default: false
            },
            sendWelcomeEmailFromSiteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          examples: [
            {
              firstName: 'Jane',
              lastName: 'Doe',
              email: 'jane@example.com',
              password: 'a-long-password',
              groups: []
            }
          ]
        },
        response: {
          200: {
            description: 'User created successfully',
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
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The user could not be created.' }
        }
      }
    },
    async (req, reply) => {
      // -> Resolved here so the refusal below and the welcome email agree with what `createUser`
      //    will store: an explicit `name` wins, as it does in `resolveNameFields`.
      const displayName =
        req.body.name ?? deriveDisplayName(req.body.firstName ?? '', req.body.lastName ?? '')
      // -> Also refuses the empty name a create carrying neither half nor a `name` would produce
      if (!/^[^<>"]+$/.test(displayName)) {
        throw new CustomError('userCreateInvalidName', 'Invalid User Name')
      }
      for (const half of [req.body.firstName, req.body.lastName]) {
        if (half !== undefined && half !== '' && !/^[^<>"]+$/.test(half)) {
          throw new CustomError('userCreateInvalidName', 'Invalid User Name')
        }
      }
      if (await CARDINAL.models.users.getByEmail(req.body.email.toLowerCase())) {
        throw new CustomError('userCreateDuplicateEmail', 'A user with this email already exists.')
      }
      // -> Before the user is created: afterwards there is an account and nowhere to mail from
      if (req.body.sendWelcomeEmail && !CARDINAL.models.mail.isConfigured()) {
        throw new CustomError(
          'userCreateWelcomeEmailUnavailable',
          'Sending a welcome email requires a configured mail transport (Admin > Mail Configuration).'
        )
      }
      if (await CARDINAL.models.groups.hasUnknownGroupIds(req.body.groups ?? [])) {
        return reply.badRequest('ERR_UNKNOWN_GROUPS')
      }
      // -> A new account is a membership change from nothing: without this a manage:users holder
      //    could create one inside a manage:system group.
      await CARDINAL.models.groups.assertMembershipChangeAllowed(req, [], req.body.groups ?? [])

      try {
        const id = await CARDINAL.models.users.createUser({
          // -> Passed only when the caller authored one: omitting it is what lets
          //    `resolveNameFields` derive and leave the account tracking later half edits.
          name: req.body.name,
          firstName: req.body.firstName,
          lastName: req.body.lastName,
          email: req.body.email,
          password: req.body.password,
          groups: req.body.groups ?? [],
          mustChangePassword: req.body.mustChangePassword ?? false
        })
        await CARDINAL.models.auditLog.record({
          event: 'user.created',
          actor: actorFromRequest(req),
          targetType: 'user',
          targetId: id,
          targetLabel: req.body.email,
          detail: { groups: req.body.groups ?? [] }
        })
        if (req.body.sendWelcomeEmail) {
          try {
            const token = await CARDINAL.models.userCredentials.generateToken({
              kind: 'resetPwd',
              userId: id,
              meta: { strategyId: CARDINAL.data.systemIds.localAuthId }
            })
            await CARDINAL.models.mail.sendWelcomeEmail({
              to: req.body.email,
              name: displayName,
              token,
              siteId: req.body.sendWelcomeEmailFromSiteId,
              userId: id
            })
          } catch (err: any) {
            // -> The user already exists: a failed welcome email must not read as a failed creation
            CARDINAL.logger.warn('mail', 'sending the welcome email failed', {
              user: id,
              site: req.body.sendWelcomeEmailFromSiteId,
              error: err
            })
          }
        }
        return {
          ok: true,
          message: 'User created successfully.',
          id
        }
      } catch (err: any) {
        CARDINAL.logger.error('http', 'creating a user failed', { error: err, reqId: req.id })
        return reply.internalServerError()
      }
    }
  )

  app.put<{ Params: { userId: string }; Body: UserUpdateBody }>(
    '/:userId',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: 'Update a user',
        description:
          'Updates any subset of the user fields. Omitted fields are left unchanged. Passing `groups` replaces the group membership entirely — except for system users (the guest account), whose membership is fixed.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['userId']
        },
        body: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description:
                'The display name. Sending it authors it, so it survives later half edits - unless it is exactly what `firstName`/`lastName` derive to, which puts the account back on derivation instead.'
            },
            firstName: {
              type: 'string',
              maxLength: 255
            },
            lastName: {
              type: 'string',
              maxLength: 255,
              description:
                'May be empty - a mononym derives its display name from `firstName` alone.'
            },
            email: {
              type: 'string',
              format: 'email',
              maxLength: 255
            },
            isActive: {
              type: 'boolean'
            },
            isVerified: {
              type: 'boolean'
            },
            meta: {
              type: 'object',
              additionalProperties: true
            },
            prefs: {
              type: 'object',
              additionalProperties: true
            },
            groups: {
              type: 'array',
              items: {
                type: 'string',
                format: 'uuid'
              }
            },
            auth: {
              type: 'object',
              description:
                'Local-strategy flags: `mustChangePwd`, `restrictLogin`, `tfaRequired`. Secrets cannot be set here — use the password endpoint.',
              properties: {
                mustChangePwd: {
                  type: 'boolean'
                },
                restrictLogin: {
                  type: 'boolean'
                },
                tfaRequired: {
                  type: 'boolean'
                }
              }
            }
          }
        },
        response: {
          200: {
            description: 'User updated successfully',
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
          409: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The user could not be updated.' }
        }
      }
    },
    async (req, reply) => {
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      const patch: UserPatch = {}
      // -> The three name fields go through untouched: `updateUser` owns the derive-unless-authored
      //    rule and decides what `name` ends up being.
      for (const key of [
        'name',
        'firstName',
        'lastName',
        'email',
        'isActive',
        'isVerified',
        'meta',
        'prefs'
      ] as const) {
        if (req.body[key] !== undefined) {
          ;(patch as Record<string, any>)[key] = req.body[key]
        }
      }

      if (
        Object.keys(patch).length < 1 &&
        req.body.groups === undefined &&
        req.body.auth === undefined
      ) {
        throw new CustomError('userUpdateEmpty', 'No user fields provided to update.')
      }

      // -> Email is unique, so a clash needs a clearer answer than a constraint violation
      if (patch.email && patch.email.toLowerCase() !== user.email.toLowerCase()) {
        if (await CARDINAL.models.users.getByEmail(patch.email.toLowerCase())) {
          throw new CustomError(
            'userUpdateDuplicateEmail',
            'A user with this email already exists.'
          )
        }
      }

      // -> Group membership is replaced wholesale here, which would otherwise be a way around the
      //    guards on the groups endpoint.
      if (req.body.groups !== undefined) {
        if (await CARDINAL.models.groups.hasUnknownGroupIds(req.body.groups)) {
          return reply.badRequest('ERR_UNKNOWN_GROUPS')
        }

        // -> The guest account must stay in the guests group and nowhere else. Resending the
        //    membership unchanged is allowed, so that saving another field is not blocked.
        if (user.isSystem) {
          const current = await CARDINAL.models.users.getUserGroupIds(req.params.userId)
          const requested = req.body.groups
          const unchanged =
            current.length === requested.length && current.every((id) => requested.includes(id))
          if (!unchanged) {
            return reply.conflict('Cannot change the group membership of a system user.')
          }
        }

        /*
          Adding or removing a group carrying manage:users, manage:groups or manage:system is a
          privilege change: see `Groups.assertMembershipChangeAllowed`. A user already in a
          manage:system group is protected by `systemUserGuard` above, which has refused this
          request before it gets here.
        */
        await CARDINAL.models.groups.assertMembershipChangeAllowed(
          req,
          await CARDINAL.models.users.getUserGroupIds(req.params.userId),
          req.body.groups
        )

        const rootAdminGroupId = CARDINAL.config.auth.rootAdminGroupId
        const wasRootAdmin = await CARDINAL.models.groups.isUserInGroup(
          rootAdminGroupId,
          req.params.userId
        )
        if (wasRootAdmin && !req.body.groups.includes(rootAdminGroupId)) {
          if ((await CARDINAL.models.groups.countUsersInGroup(rootAdminGroupId)) <= 1) {
            return reply.conflict('Cannot remove the last user from the root administrators group.')
          }
        }
      }

      try {
        // -> One transaction for the whole write sequence -- session clearing and token purging on
        //    deactivation included -- so a failure partway through leaves nothing committed.
        await CARDINAL.models.users.applyUserUpdate(req.params.userId, {
          patch,
          groups: req.body.groups,
          authFlags: req.body.auth
        })
        await CARDINAL.models.auditLog.record({
          event: 'user.updated',
          actor: actorFromRequest(req),
          targetType: 'user',
          targetId: user.id,
          targetLabel: user.email,
          detail: {
            changedFields: Object.keys(patch),
            ...(req.body.groups !== undefined && { groups: req.body.groups }),
            ...(req.body.auth !== undefined && { auth: Object.keys(req.body.auth) })
          }
        })
        return {
          ok: true,
          message: 'User updated successfully.'
        }
      } catch (err: any) {
        CARDINAL.logger.error('http', 'updating a user failed', {
          user: req.params.userId,
          error: err,
          reqId: req.id
        })
        return reply.internalServerError()
      }
    }
  )

  app.put<{
    Params: { userId: string }
    Body: { newPassword: string; mustChangePassword?: boolean }
  }>(
    '/:userId/password',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: "Set a user's password",
        description: 'Replaces the local-strategy password. Other linked providers are untouched.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['userId']
        },
        body: {
          type: 'object',
          required: ['newPassword'],
          properties: {
            newPassword: {
              type: 'string',
              minLength: 8,
              maxLength: 255
            },
            mustChangePassword: {
              type: 'boolean',
              default: false
            }
          }
        },
        response: {
          200: {
            description: 'Password updated successfully',
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
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const systemUserRefusal = await systemUserGuard(req, req.params.userId)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      const updated = await CARDINAL.models.userCredentials.setUserPassword({
        id: req.params.userId,
        newPassword: req.body.newPassword,
        mustChangePassword: req.body.mustChangePassword ?? false
      })
      if (!updated) {
        return reply.notFound('User does not exist.')
      }
      const user = await CARDINAL.models.users.getById(req.params.userId)
      await CARDINAL.models.auditLog.record({
        event: 'user.passwordReset',
        actor: actorFromRequest(req),
        targetType: 'user',
        targetId: req.params.userId,
        targetLabel: user?.email ?? ''
      })
      return {
        ok: true,
        message: 'User password updated successfully.'
      }
    }
  )

  app.get<{ Params: { userId: string } }>(
    '/:userId/passkeys',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: "List a user's passkeys",
        description: 'Never returns key material — the same shape the profile page itself lists.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['userId']
        },
        response: {
          200: {
            description: "The user's passkeys",
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              passkeys: {
                type: 'array',
                items: { $ref: 'Passkey#' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }
      const passkeys = await CARDINAL.models.passkeys.list(req.params.userId)
      return {
        ok: true,
        passkeys
      }
    }
  )

  app.delete<{ Params: { userId: string; passkeyId: string } }>(
    '/:userId/passkeys/:passkeyId',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: "Revoke one of a user's passkeys",
        description:
          'Only this instance forgets it — the credential itself lives on the user’s device and has to be deleted there too. Refused with `ERR_PASSKEY_LAST_LOGIN_METHOD` when it is the last way into the account, as `DELETE /users/:userId/auth/:strategyId` refuses the last provider: set the user a password first.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            },
            passkeyId: {
              type: 'string',
              description: 'The credential ID, as listed by `GET /users/:userId/passkeys`.'
            }
          },
          required: ['userId', 'passkeyId']
        },
        response: {
          204: {
            description: 'Passkey revoked successfully'
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      let wasRemoved = false
      try {
        wasRemoved = await CARDINAL.models.passkeys.remove(req.params.userId, req.params.passkeyId)
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }
      if (!wasRemoved) {
        return reply.notFound('This user has no passkey with this ID.')
      }
      return reply.code(204).send()
    }
  )

  app.delete<{ Params: { userId: string; strategyId: string } }>(
    '/:userId/auth/:strategyId',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: "Disconnect a sign-in method from a user's account",
        description:
          'The administrator counterpart of `DELETE /users/profile/auth/:strategyId`, with the same refusals: never the local strategy, never a provider that is not linked, and never the last way into the account. The account holder is emailed a notice, and the audit log records the administrator as the actor.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            },
            strategyId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['userId', 'strategyId']
        },
        response: {
          204: {
            description: 'Sign-in method disconnected successfully'
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      try {
        await CARDINAL.models.userCredentials.unlinkStrategy({
          userId: user.id,
          strategyId: req.params.strategyId,
          actor: actorFromRequest(req)
        })
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }

      return reply.code(204).send()
    }
  )

  app.post<{ Params: { userId: string }; Body: { strategyId: string } }>(
    '/:userId/tfa/invalidate',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: "Turn off a user's 2FA on an administrator's authority",
        description:
          'Unlike `DELETE /users/profile/tfa/:strategyId`, this bypasses the `tfaRequired` / `enforceTfa` enforcement that route refuses to override — the exact override an administrator needs to recover a user locked out of a lost authenticator or device. Clears the stored secret, deactivates 2FA, and discards every recovery code; the user has to set 2FA up again from scratch.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['userId']
        },
        body: {
          type: 'object',
          required: ['strategyId'],
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          }
        },
        response: {
          200: {
            description: '2FA invalidated successfully',
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
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      try {
        await CARDINAL.models.userCredentials.adminInvalidateTfa(
          req.params.userId,
          req.body.strategyId
        )
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }

      await CARDINAL.models.auditLog.record({
        event: 'user.tfaDisabledByAdmin',
        actor: actorFromRequest(req),
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.email
      })

      return {
        ok: true,
        message: '2FA invalidated successfully.'
      }
    }
  )

  app.post<{ Params: { userId: string }; Body: { targetUserId: string } }>(
    '/:userId/reassignContent',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: 'Reassign a user’s authored content to another user',
        description:
          'Transfers every page (as author, creator, and/or owner) and every asset `userId` authored to `targetUserId`, in a single bulk action. Use this ahead of deleting a user who still owns pages or assets — the delete route refuses until nothing points at them anymore.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['userId']
        },
        body: {
          type: 'object',
          properties: {
            targetUserId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['targetUserId']
        },
        response: {
          200: {
            description: 'Content reassigned successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              pagesReassigned: {
                type: 'integer'
              },
              assetsReassigned: {
                type: 'integer'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      try {
        const result = await CARDINAL.models.users.reassignContent(user.id, req.body.targetUserId)
        return {
          ok: true,
          message: 'Content reassigned successfully.',
          ...result
        }
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }
    }
  )

  app.delete<{ Params: { userId: string } }>(
    '/:userId',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: 'Delete a user',
        description:
          'System users cannot be deleted, nor the account the caller is signed in as, nor the last user of the root administrators group. A user who has authored pages or assets cannot be deleted either — deactivate them, or reassign what they own.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['userId']
        },
        response: {
          204: {
            description: 'User deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The user could not be deleted.' }
        }
      }
    },
    async (req, reply) => {
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      // -> The guest account is the only system user, and anonymous access is resolved through it
      if (user.isSystem) {
        return reply.conflict('Cannot delete a system user.')
      }

      /*
        Not your own account, whatever permissions you hold: the request would end the session making
        it, and an administrator who did it by accident has nothing left to undo it with.
      */
      if (user.id === sessionUserIdOrNull(req)) {
        return reply.conflict('You cannot delete your own account. Another administrator can.')
      }

      // -> Emptying the root administrators group would lock everyone out of system management
      const rootAdminGroupId = CARDINAL.config.auth.rootAdminGroupId
      if (await CARDINAL.models.groups.isUserInGroup(rootAdminGroupId, user.id)) {
        if ((await CARDINAL.models.groups.countUsersInGroup(rootAdminGroupId)) <= 1) {
          return reply.conflict('Cannot delete the last user of the root administrators group.')
        }
      }

      try {
        await CARDINAL.models.users.deleteUser(user.id)
        await CARDINAL.models.auditLog.record({
          event: 'user.deleted',
          actor: actorFromRequest(req),
          targetType: 'user',
          targetId: user.id,
          targetLabel: user.email
        })
        return reply.code(204).send()
      } catch (err: any) {
        // -> Several tables reference users without a cascade. A row left in one is a conflict to
        //    report, not a server fault, and Postgres names the constraint that tripped.
        const pgErr = err.cause?.code ? err.cause : err
        if (pgErr.code === '23503') {
          const blocker = DELETE_USER_BLOCKING_RELATIONS[pgErr.constraint as string]
          return reply.conflict(
            blocker
              ? `Cannot delete a user who still has ${blocker.relation}. ${blocker.remedy}`
              : 'Cannot delete a user who still owns pages or assets. Reassign them first.'
          )
        }
        CARDINAL.logger.error('http', 'deleting a user failed', {
          user: req.params.userId,
          error: err,
          reqId: req.id
        })
        return reply.internalServerError()
      }
    }
  )
}

export default routes
