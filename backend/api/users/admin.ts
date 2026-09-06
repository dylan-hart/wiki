import type { FastifyInstance, FastifyRequest } from 'fastify'
import { CustomError, rethrowAsBadRequest } from '../../helpers/common.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import { deriveDisplayName, type UserPatch } from '../../models/users.ts'
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
 * What blocks `DELETE /:userId` on a `23503` foreign key violation, keyed by the Postgres constraint
 * name (`db/schema.ts`'s `<table>_<column>_users_id_fkey` naming, confirmed against
 * `db/migrations/*_main/snapshot.json`) -- so the 409 can name the actual relation rather than a
 * hard-coded guess. `remedy` is only ever the reassign advice for the two constraints
 * `WIKI.models.users.reassignContent()` actually clears; `pageEditSubmissions.authorId` has no
 * reassign path (see that method's doc comment), so its remedy points at resolving the submission
 * instead.
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
 * Who is asking, as the interface needs to know it: the account on the session and the group-wide
 * permissions it holds, or nothing at all for a guest.
 *
 * Exported because `bootstrap` answers the same question as part of the one call an app load makes,
 * and two versions of "who is this" would be one too many.
 */
export function whoAmI(req: FastifyRequest): Record<string, any> {
  if (!req.session?.authenticated) {
    return { authenticated: false }
  }
  return {
    authenticated: true,
    ...req.session.user,
    /*
      The same list the route permission hook checks against — written onto the session at login from
      the groups the user belongs to. Nothing is added for the interface's benefit: a control it shows
      on a permission the session does not hold leads to a button that gets a 403 from the endpoint
      behind it.
    */
    permissions: req.session.permissions ?? []
  }
}

/**
 * Refuse a `manage:users` holder any change to a user who is protected by `manage:system`.
 *
 * `manage:users` is deliberately short of the root: an administrator who can rename, re-group, reset
 * the password of, or delete a `manage:system` account can take the instance over through it. Only
 * somebody who already holds `manage:system` may touch one.
 *
 * @returns The refusal to throw, or null when the caller may proceed
 */
async function systemUserGuard(req: FastifyRequest, userId: string): Promise<CustomError | null> {
  if (WIKI.models.groups.holdsSystemPermission(req)) {
    return null
  }
  if (!(await WIKI.models.groups.userHoldsSystemPermission(userId))) {
    return null
  }
  return new CustomError(
    'userSystemProtected',
    'This user belongs to a group with the manage:system permission. Only a user who holds manage:system can modify them.',
    403
  )
}

/**
 * User administration: the account list, the per-account CRUD an administrator performs on somebody
 * else's user, and the instance-wide defaults new accounts are created with. Every route here is
 * gated by `config.permissions` -- `read:users` / `manage:users` -- except `GET /whoami`, which
 * answers about the caller themselves.
 */
async function routes(app: FastifyInstance) {
  app.get<{
    // -> `page`/`limit` are non-optional: the querystring schema declares a `default` for each, and
    //    fastify's AJV runs with `useDefaults`, so a missing param is filled in before the handler
    //    sees it.
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
      const { total, users } = await WIKI.models.users.getUsers({
        filter: req.query.filter ?? '',
        assignableToGroupId: req.query.assignableToGroupId ?? '',
        page,
        limit
      })
      return { page, limit, total, users }
    }
  )

  /**
   * RECENT LOGINS
   */
  // -> `limit` is non-optional: the querystring schema declares a `default` for it, and fastify's
  //    AJV runs with `useDefaults`, so a missing param is filled in before the handler sees it.
  app.get<{ Querystring: { limit: number } }>(
    '/recent-logins',
    {
      config: {
        // -> `access:admin`, not `read:users`: this answers a panel on the admin dashboard, which
        //    everyone who can open the admin area sees, and it is the same permission `system/info`
        //    fills the rest of that dashboard with. It is why the answer is identity plus a timestamp
        //    and nothing else -- the user list, and every account flag on it, still needs `read:users`.
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
      return WIKI.models.users.getRecentLogins({ limit: req.query.limit })
    }
  )

  /**
   * FALLBACK ACCOUNTS REPORT
   *
   * Every migrated provider-fallback account still on `mustChangePwd`, with its original 2.x
   * `providerKey` — replaces the raw SQL query `docs/migration/migration-runbook.md`'s Step 3 used
   * to send an administrator to run by hand.
   */
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
      return WIKI.models.users.getFallbackAccounts()
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
      return whoAmI(req)
    }
  )

  /**
   * GET USER DEFAULTS
   *
   * Instance-wide, not per-site: stored as the `userDefaults` key of the settings table.
   */
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
      return WIKI.config.userDefaults
    }
  )

  /**
   * UPDATE USER DEFAULTS
   */
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

      const previousDefaults = WIKI.config.userDefaults
      WIKI.config.userDefaults = { ...previousDefaults, ...patch }

      if (!(await WIKI.configSvc.saveToDb(['userDefaults']))) {
        WIKI.config.userDefaults = previousDefaults
        return reply.internalServerError('Failed to save user defaults.')
      }

      return {
        ok: true,
        message: 'User defaults updated successfully.'
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
      const user = await WIKI.models.users.getUserDetail(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }
      return user
    }
  )

  /**
   * CREATE USER
   */
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
      // -> Whatever the account will actually be called, resolved here so the refusal below and the
      //    welcome email agree with what `createUser` is about to store. `deriveDisplayName` is the
      //    ONE composer of a display name (`models/users.ts`), so this is not a second derivation --
      //    an explicit `name` still wins, exactly as `resolveNameFields` treats it.
      const displayName =
        req.body.name ?? deriveDisplayName(req.body.firstName ?? '', req.body.lastName ?? '')
      // -> A create carrying neither half nor a name would otherwise silently produce an account
      //    called '', so the emptiness is refused with the same code an unusable name already used.
      if (!/^[^<>"]+$/.test(displayName)) {
        throw new CustomError('userCreateInvalidName', 'Invalid User Name')
      }
      for (const half of [req.body.firstName, req.body.lastName]) {
        if (half !== undefined && half !== '' && !/^[^<>"]+$/.test(half)) {
          throw new CustomError('userCreateInvalidName', 'Invalid User Name')
        }
      }
      if (await WIKI.models.users.getByEmail(req.body.email.toLowerCase())) {
        throw new CustomError('userCreateDuplicateEmail', 'A user with this email already exists.')
      }
      // -> Refuse up front, before the user is created, rather than creating it and only then
      //    discovering there is nowhere to send the email from.
      if (req.body.sendWelcomeEmail && !WIKI.models.mail.isConfigured()) {
        throw new CustomError(
          'userCreateWelcomeEmailUnavailable',
          'Sending a welcome email requires a configured mail transport (Admin > Mail Configuration).'
        )
      }
      if (await WIKI.models.groups.hasUnknownGroupIds(req.body.groups ?? [])) {
        return reply.badRequest('ERR_UNKNOWN_GROUPS')
      }

      try {
        const id = await WIKI.models.users.createUser({
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
        await WIKI.models.auditLog.record({
          event: 'user.created',
          actor: actorFromRequest(req),
          targetType: 'user',
          targetId: id,
          targetLabel: req.body.email,
          detail: { groups: req.body.groups ?? [] }
        })
        if (req.body.sendWelcomeEmail) {
          try {
            const token = await WIKI.models.userCredentials.generateToken({
              kind: 'resetPwd',
              userId: id,
              meta: { strategyId: WIKI.data.systemIds.localAuthId }
            })
            await WIKI.models.mail.sendWelcomeEmail({
              to: req.body.email,
              name: displayName,
              token,
              siteId: req.body.sendWelcomeEmailFromSiteId
            })
          } catch (err: any) {
            // -> The user already exists; a failed welcome email must not turn this into a failed
            //    creation, same as `resetPassword`'s own sendPasswordResetConfirmed catch.
            WIKI.logger.warn(
              `Failed to send the welcome email to ${req.body.email}: ${err.message}`
            )
          }
        }
        return {
          ok: true,
          message: 'User created successfully.',
          id
        }
      } catch (err: any) {
        WIKI.logger.warn(err)
        return reply.internalServerError()
      }
    }
  )

  /**
   * UPDATE USER
   */
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
      const user = await WIKI.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      // -> Collect only the fields actually provided
      const patch: UserPatch = {}
      // -> The three name fields go through untouched: `updateUser` is the one owner of the
      //    derive-unless-authored rule (Feature #2608) and decides what `name` ends up being.
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
        if (await WIKI.models.users.getByEmail(patch.email.toLowerCase())) {
          throw new CustomError(
            'userUpdateDuplicateEmail',
            'A user with this email already exists.'
          )
        }
      }

      // -> Group membership is replaced wholesale here, which would otherwise be a way around the
      //    guards on the groups endpoint.
      if (req.body.groups !== undefined) {
        if (await WIKI.models.groups.hasUnknownGroupIds(req.body.groups)) {
          return reply.badRequest('ERR_UNKNOWN_GROUPS')
        }

        // -> The guest account must stay in the guests group and nowhere else. Resending the
        //    membership unchanged is allowed, so that saving another field is not blocked.
        if (user.isSystem) {
          const current = await WIKI.models.users.getUserGroupIds(req.params.userId)
          const requested = req.body.groups
          const unchanged =
            current.length === requested.length && current.every((id) => requested.includes(id))
          if (!unchanged) {
            return reply.conflict('Cannot change the group membership of a system user.')
          }
        }

        /*
          Handing somebody `manage:system` by putting them in a group that carries it. Only ADDING is
          checked: a user already in such a group is protected by `systemUserGuard` above, which has
          refused this request before it gets here.
        */
        if (!WIKI.models.groups.holdsSystemPermission(req)) {
          const current = await WIKI.models.users.getUserGroupIds(req.params.userId)
          const systemGroupIds = await WIKI.models.groups.systemGroupIds()
          const added = req.body.groups.filter((id) => !current.includes(id))
          if (added.some((id) => systemGroupIds.includes(id))) {
            throw new CustomError(
              'groupMembershipSystemProtected',
              'Only a user who holds the manage:system permission can add a user to a group that has it.',
              403
            )
          }
        }

        const rootAdminGroupId = WIKI.config.auth.rootAdminGroupId
        const wasRootAdmin = await WIKI.models.groups.isUserInGroup(
          rootAdminGroupId,
          req.params.userId
        )
        if (wasRootAdmin && !req.body.groups.includes(rootAdminGroupId)) {
          if ((await WIKI.models.groups.countUsersInGroup(rootAdminGroupId)) <= 1) {
            return reply.conflict('Cannot remove the last user from the root administrators group.')
          }
        }
      }

      try {
        // -> One transaction for the whole write sequence (OpenProject #1609): a failure partway
        //    through used to leave an earlier write here already committed behind a bare 500. Session
        //    clearing on deactivation/group-change (OpenProject #936) and outstanding-token purging on
        //    deactivation (OpenProject #2094) are both folded into the same method -- see
        //    `applyUserUpdate`'s own doc comment.
        await WIKI.models.users.applyUserUpdate(req.params.userId, {
          patch,
          groups: req.body.groups,
          authFlags: req.body.auth
        })
        await WIKI.models.auditLog.record({
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
        WIKI.logger.warn(err)
        return reply.internalServerError()
      }
    }
  )

  /**
   * SET USER PASSWORD
   */
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

      const updated = await WIKI.models.userCredentials.setUserPassword({
        id: req.params.userId,
        newPassword: req.body.newPassword,
        mustChangePassword: req.body.mustChangePassword ?? false
      })
      if (!updated) {
        return reply.notFound('User does not exist.')
      }
      const user = await WIKI.models.users.getById(req.params.userId)
      await WIKI.models.auditLog.record({
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

  /**
   * LIST A USER'S PASSKEYS (ADMIN)
   */
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
      const user = await WIKI.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }
      const passkeys = await WIKI.models.passkeys.list(req.params.userId)
      return {
        ok: true,
        passkeys
      }
    }
  )

  /**
   * REVOKE A USER'S PASSKEY (ADMIN)
   */
  app.delete<{ Params: { userId: string; passkeyId: string } }>(
    '/:userId/passkeys/:passkeyId',
    {
      config: {
        permissions: ['manage:users']
      },
      schema: {
        summary: "Revoke one of a user's passkeys",
        description:
          'Only this instance forgets it — the credential itself lives on the user’s device and has to be deleted there too.',
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
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const user = await WIKI.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      if (!(await WIKI.models.passkeys.remove(req.params.userId, req.params.passkeyId))) {
        return reply.notFound('This user has no passkey with this ID.')
      }
      return reply.code(204).send()
    }
  )

  /**
   * INVALIDATE A USER'S 2FA (ADMIN)
   */
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
      const user = await WIKI.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      try {
        await WIKI.models.userCredentials.adminInvalidateTfa(req.params.userId, req.body.strategyId)
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }

      await WIKI.models.auditLog.record({
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
      const user = await WIKI.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemUserRefusal = await systemUserGuard(req, user.id)
      if (systemUserRefusal) {
        throw systemUserRefusal
      }

      try {
        const result = await WIKI.models.users.reassignContent(user.id, req.body.targetUserId)
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
      const user = await WIKI.models.users.getById(req.params.userId)
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
        it, and an administrator who did it by accident has nothing left to undo it with. Another
        administrator can — which is also the answer to an account that has to go and cannot ask.
      */
      if (user.id === sessionUserIdOrNull(req)) {
        return reply.conflict('You cannot delete your own account. Another administrator can.')
      }

      // -> Emptying the root administrators group would lock everyone out of system management
      const rootAdminGroupId = WIKI.config.auth.rootAdminGroupId
      if (await WIKI.models.groups.isUserInGroup(rootAdminGroupId, user.id)) {
        if ((await WIKI.models.groups.countUsersInGroup(rootAdminGroupId)) <= 1) {
          return reply.conflict('Cannot delete the last user of the root administrators group.')
        }
      }

      try {
        await WIKI.models.users.deleteUser(user.id)
        await WIKI.models.auditLog.record({
          event: 'user.deleted',
          actor: actorFromRequest(req),
          targetType: 'user',
          targetId: user.id,
          targetLabel: user.email
        })
        return reply.code(204).send()
      } catch (err: any) {
        // -> Several tables reference users without a cascade, so a user who still has a row in one
        //    of them cannot be removed. That is a conflict to report, not a server fault -- and
        //    Postgres names the specific constraint that tripped, so the reply can name the specific
        //    relation instead of guessing at "pages or assets".
        const pgErr = err.cause?.code ? err.cause : err
        if (pgErr.code === '23503') {
          const blocker = DELETE_USER_BLOCKING_RELATIONS[pgErr.constraint as string]
          return reply.conflict(
            blocker
              ? `Cannot delete a user who still has ${blocker.relation}. ${blocker.remedy}`
              : 'Cannot delete a user who still owns pages or assets. Reassign them first.'
          )
        }
        WIKI.logger.warn(err)
        return reply.internalServerError()
      }
    }
  )
}

export default routes
