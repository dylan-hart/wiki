import { CustomError } from '../helpers/common.ts'
import { absoluteRedirectsAllowed, isFollowableRedirectTarget } from '../helpers/redirectTarget.ts'
import { actorFromRequest } from '../models/auditLog.ts'
import { SYSTEM_PERMISSION } from '../models/groups.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { GroupPatch, GroupRule, GroupWithUserCount } from '../models/groups.ts'

/**
 * Membership of a group that carries `manage:system` IS the permission: adding somebody hands them
 * the root of the instance, removing somebody takes it from a real administrator, and deleting the
 * group does both at once. Only a holder of it may do any of the three.
 */
function systemGroupGuard(
  req: FastifyRequest,
  group: GroupWithUserCount,
  action = 'change who belongs to the group'
): CustomError | null {
  if (!group.permissions.includes(SYSTEM_PERMISSION)) {
    return null
  }
  if (CARDINAL.models.groups.holdsSystemPermission(req)) {
    return null
  }
  return new CustomError(
    'groupMembershipSystemProtected',
    `This group has the ${SYSTEM_PERMISSION} permission. Only a user who holds it can ${action}.`,
    403
  )
}

interface GroupUpdateBody {
  name?: string
  redirectOnLogin?: string
  redirectOnFirstLogin?: string
  redirectOnLogout?: string
  permissions?: string[]
  rules?: GroupRule[]
}

const LIST_GROUPS_GLOBAL_PERMISSIONS = [
  'read:groups',
  'manage:groups',
  'manage:navigation',
  'manage:sites'
]

/**
 * An in-handler check because `config.permissions` reads the group-wide list only, and a
 * `site:approvals` or `site:navigation` delegate holds its grant on a site-scoped rule. Both need
 * this listing (`GroupCore` only) for their group pickers. `manage:sites` is in the global list so
 * a full site administrator lists groups everywhere, not only where a rule grants one of those two.
 */
function mayListGroups(req: FastifyRequest): boolean {
  const actor = CARDINAL.models.groups.actorForRequest(req)
  if (LIST_GROUPS_GLOBAL_PERMISSIONS.some((permission) => actor.permissions.includes(permission))) {
    return true
  }
  // -> `null`: this listing is not site-scoped, so there is no site to narrow by.
  return CARDINAL.models.groups.mayHoldPermissionSomewhere(
    actor,
    ['site:approvals', 'site:navigation'],
    null
  )
}

async function routes(app: FastifyInstance) {
  // No route-level permissions: a site-scoped delegate's grant is invisible to config.permissions —
  // see mayListGroups().
  app.get(
    '/',
    {
      schema: {
        summary: 'List all groups',
        description:
          'Every group by id and name, with its member count. Nothing about what a group may do or who is in it — that is `GET /groups/{groupId}`.',
        tags: ['Groups'],
        response: {
          200: {
            description: 'List of all groups',
            type: 'array',
            items: { $ref: 'GroupCore#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!mayListGroups(req)) {
        return reply.forbidden()
      }
      return CARDINAL.models.groups.getAllGroups()
    }
  )

  app.post<{ Body: { name: string } }>(
    '/',
    {
      config: {
        permissions: ['manage:groups']
      },
      schema: {
        summary: 'Create a new group',
        description:
          'Creates a non-system group, seeded with the same starting permissions and default rule as the built-in `Users` group.',
        tags: ['Groups'],
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            }
          },
          examples: [{ name: 'Editors' }]
        },
        response: {
          200: {
            description: 'Group created successfully',
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
          500: { $ref: 'ApiError#', description: 'The group could not be created.' }
        }
      }
    },
    async (req, reply) => {
      if (!/^[^<>"]+$/.test(req.body.name)) {
        throw new CustomError('groupCreateInvalidName', 'Invalid Group Name')
      }

      try {
        const id = await CARDINAL.models.groups.createGroup(req.body.name)
        await CARDINAL.models.auditLog.record({
          event: 'group.created',
          actor: actorFromRequest(req),
          targetType: 'group',
          targetId: id,
          targetLabel: req.body.name
        })
        return {
          ok: true,
          message: 'Group created successfully.',
          id
        }
      } catch (err: any) {
        CARDINAL.logger.error('http', 'creating a group failed', { error: err, reqId: req.id })
        return reply.internalServerError()
      }
    }
  )

  app.get<{ Params: { groupId: string } }>(
    '/:groupId',
    {
      config: {
        permissions: ['read:groups', 'manage:groups']
      },
      schema: {
        summary: 'Get a single group',
        description: 'Returns the group with its full permissions and page rules.',
        tags: ['Groups'],
        params: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['groupId']
        },
        response: {
          200: {
            description: 'Group info',
            type: 'object',
            $ref: 'Group#'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const group = await CARDINAL.models.groups.getGroupById(req.params.groupId)
      if (!group) {
        return reply.notFound('Group does not exist.')
      }
      return group
    }
  )

  app.put<{ Params: { groupId: string }; Body: GroupUpdateBody }>(
    '/:groupId',
    {
      config: {
        permissions: ['manage:groups']
      },
      schema: {
        summary: 'Update a group',
        description:
          'Updates any subset of the group fields. Omitted fields are left unchanged. The permissions of the root administrators group cannot be modified.',
        tags: ['Groups'],
        params: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['groupId']
        },
        body: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            redirectOnLogin: {
              type: 'string',
              maxLength: 255
            },
            redirectOnFirstLogin: {
              type: 'string',
              maxLength: 255
            },
            redirectOnLogout: {
              type: 'string',
              maxLength: 255
            },
            permissions: {
              type: 'array',
              items: { $ref: 'GlobalPermission#' }
            },
            rules: {
              type: 'array',
              items: { $ref: 'GroupRule#' }
            }
          },
          examples: [
            {
              name: 'Editors',
              permissions: ['read:pages', 'write:pages']
            }
          ]
        },
        response: {
          200: {
            description: 'Group updated successfully',
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
          500: { $ref: 'ApiError#', description: 'The group could not be updated.' }
        }
      }
    },
    async (req, reply) => {
      const group = await CARDINAL.models.groups.getGroupById(req.params.groupId)
      if (!group) {
        return reply.notFound('Group does not exist.')
      }

      const patch: GroupPatch = {}
      if (req.body.name !== undefined) {
        patch.name = req.body.name
      }
      /*
        Empty string is the column default and means "no redirect configured" -- not a target to
        validate. Anything else reaches `AuthLoginPanel.vue`'s `window.location.replace()`, which
        would execute a stored `javascript:…` in the next administrator's session on login.
      */
      const allowAbsolute = absoluteRedirectsAllowed()
      for (const field of [
        'redirectOnLogin',
        'redirectOnFirstLogin',
        'redirectOnLogout'
      ] as const) {
        const value = req.body[field]
        if (value === undefined) {
          continue
        }
        if (value !== '' && !isFollowableRedirectTarget(value, { allowAbsolute })) {
          throw new CustomError(
            'groupRedirectInvalid',
            `${field} must be a path on this wiki${allowAbsolute ? ' or a complete http(s) URL' : ''}.`,
            400
          )
        }
        patch[field] = value
      }

      if (req.body.permissions !== undefined) {
        patch.permissions = req.body.permissions
      }
      if (req.body.rules !== undefined) {
        patch.rules = req.body.rules
      }

      if (Object.keys(patch).length < 1) {
        throw new CustomError('groupUpdateEmpty', 'No group fields provided to update.')
      }

      // -> The root administrators group must keep its permissions, or the instance becomes
      //    unmanageable with no way to grant `manage:system` back. Resending the current set is
      //    allowed, so that a client editing other fields can still submit the whole group.
      if (patch.permissions && group.id === CARDINAL.config.auth.rootAdminGroupId) {
        const isUnchanged =
          patch.permissions.length === group.permissions.length &&
          patch.permissions.every((p) => group.permissions.includes(p))
        if (!isUnchanged) {
          throw new CustomError(
            'groupUpdateRootAdminPermissions',
            'Cannot modify the permissions of the root administrators group.'
          )
        }
      }

      /*
        A `manage:groups` holder may edit a group that carries `manage:system` -- name, rules,
        redirects, every other permission -- but may not turn that one permission on or off. Granting
        it is handing over the instance; revoking it is locking the real administrators out.
      */
      if (patch.permissions && !CARDINAL.models.groups.holdsSystemPermission(req)) {
        const held = group.permissions.includes(SYSTEM_PERMISSION)
        if (held !== patch.permissions.includes(SYSTEM_PERMISSION)) {
          throw new CustomError(
            'groupUpdateSystemPermission',
            `Only a user who holds the ${SYSTEM_PERMISSION} permission can grant or revoke it. Every other change to this group is allowed.`,
            403
          )
        }
      }

      // -> Rule IDs must be unique within the group, as they address the rule client-side
      if (patch.rules) {
        const ruleIds = patch.rules.map((r) => r.id)
        if (new Set(ruleIds).size !== ruleIds.length) {
          throw new CustomError('groupUpdateDuplicateRuleId', 'Group rule IDs must be unique.')
        }
      }

      try {
        await CARDINAL.models.groups.updateGroup(group.id, patch)
        // -> `permissions` is flattened onto every member's `session.permissions` at login, so a
        //    revocation only takes effect once those sessions are cleared. `rules` are resolved per
        //    request (`groups.checkAccess()`) and need no such cutoff.
        if (patch.permissions !== undefined) {
          await CARDINAL.models.sessions.clearSessionsForGroup(group.id)
        }
        await CARDINAL.models.auditLog.record({
          event: 'group.updated',
          actor: actorFromRequest(req),
          targetType: 'group',
          targetId: group.id,
          targetLabel: patch.name ?? group.name,
          detail: { changedFields: Object.keys(patch) }
        })
        return {
          ok: true,
          message: 'Group updated successfully.'
        }
      } catch (err: any) {
        CARDINAL.logger.error('http', 'updating a group failed', {
          group: group.id,
          error: err,
          reqId: req.id
        })
        return reply.internalServerError()
      }
    }
  )

  app.delete<{ Params: { groupId: string } }>(
    '/:groupId',
    {
      config: {
        permissions: ['manage:groups']
      },
      schema: {
        summary: 'Delete a group',
        description:
          'Deletes the group and removes all of its user assignments. System groups cannot be deleted.',
        tags: ['Groups'],
        params: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['groupId']
        },
        response: {
          204: {
            description: 'Group deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#', description: 'The group is a built-in system group.' },
          500: { $ref: 'ApiError#', description: 'The group could not be deleted.' }
        }
      }
    },
    async (req, reply) => {
      const group = await CARDINAL.models.groups.getGroupById(req.params.groupId)
      if (!group) {
        return reply.notFound('Group does not exist.')
      }
      if (group.isSystem) {
        return reply.conflict('Cannot delete a system group.')
      }

      const systemGroupRefusal = systemGroupGuard(req, group, 'delete the group')
      if (systemGroupRefusal) {
        throw systemGroupRefusal
      }

      try {
        await CARDINAL.models.groups.deleteGroup(group.id)
        await CARDINAL.models.auditLog.record({
          event: 'group.deleted',
          actor: actorFromRequest(req),
          targetType: 'group',
          targetId: group.id,
          targetLabel: group.name
        })
        return reply.code(204).send()
      } catch (err: any) {
        CARDINAL.logger.error('http', 'deleting a group failed', {
          group: group.id,
          error: err,
          reqId: req.id
        })
        return reply.internalServerError()
      }
    }
  )

  app.get<{
    Params: { groupId: string }
    // -> `page`/`limit` are non-optional: the querystring schema declares a `default` for each, and
    //    fastify's AJV runs with `useDefaults`.
    Querystring: { filter?: string; page: number; limit: number }
  }>(
    '/:groupId/users',
    {
      config: {
        permissions: ['read:groups', 'manage:groups']
      },
      schema: {
        summary: 'List the users assigned to a group',
        description: 'Returns a page of group members, ordered by name.',
        tags: ['Groups'],
        params: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['groupId']
        },
        querystring: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description: 'Case-insensitive substring matched against the name and email.',
              maxLength: 255
            },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
          }
        },
        response: {
          200: {
            description: 'List of group members',
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
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const group = await CARDINAL.models.groups.getGroupById(req.params.groupId)
      if (!group) {
        return reply.notFound('Group does not exist.')
      }

      const { page, limit } = req.query
      const { total, users } = await CARDINAL.models.groups.getGroupUsers(group.id, {
        filter: req.query.filter,
        page,
        limit
      })

      return { page, limit, total, users }
    }
  )

  app.post<{ Params: { groupId: string; userId: string } }>(
    '/:groupId/users/:userId',
    {
      config: {
        permissions: ['manage:groups']
      },
      schema: {
        summary: 'Assign a user to a group',
        description:
          'System users (the guest account) cannot be assigned: their group membership is fixed at install time.',
        tags: ['Groups'],
        params: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              format: 'uuid'
            },
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['groupId', 'userId']
        },
        response: {
          200: {
            description: 'User assigned successfully',
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
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const group = await CARDINAL.models.groups.getGroupById(req.params.groupId)
      if (!group) {
        return reply.notFound('Group does not exist.')
      }
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (!user) {
        return reply.notFound('User does not exist.')
      }

      const systemGroupRefusal = systemGroupGuard(req, group)
      if (systemGroupRefusal) {
        throw systemGroupRefusal
      }

      // -> The guests group and the guest account belong to each other and to nothing else.
      const violation = CARDINAL.models.groups.guestMembershipViolation(group.id, user)
      if (violation) {
        return reply.conflict(violation)
      }

      const assigned = await CARDINAL.models.groups.assignUserToGroup(group.id, req.params.userId)
      if (!assigned) {
        return reply.conflict('User is already assigned to this group.')
      }
      // -> `session.groups` is a snapshot taken at login: uncleared, this user's open sessions keep
      //    resolving rules against the old membership.
      await CARDINAL.models.sessions.clearSessionsFromUser(req.params.userId)

      await CARDINAL.models.auditLog.record({
        event: 'group.memberAdded',
        actor: actorFromRequest(req),
        targetType: 'group',
        targetId: group.id,
        targetLabel: group.name,
        detail: { userId: user.id, userEmail: user.email }
      })

      return {
        ok: true,
        message: 'User assigned to group successfully.'
      }
    }
  )

  app.delete<{ Params: { groupId: string; userId: string } }>(
    '/:groupId/users/:userId',
    {
      config: {
        permissions: ['manage:groups']
      },
      schema: {
        summary: 'Unassign a user from a group',
        description:
          'Removes the user from the group. The last remaining user cannot be removed from the root administrators group, and system users (the guest account) cannot be unassigned at all.',
        tags: ['Groups'],
        params: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              format: 'uuid'
            },
            userId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['groupId', 'userId']
        },
        response: {
          204: {
            description: 'User unassigned successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const group = await CARDINAL.models.groups.getGroupById(req.params.groupId)
      if (!group) {
        return reply.notFound('Group does not exist.')
      }
      if (!(await CARDINAL.models.groups.isUserInGroup(group.id, req.params.userId))) {
        return reply.notFound('User is not assigned to this group.')
      }

      const systemGroupRefusal = systemGroupGuard(req, group)
      if (systemGroupRefusal) {
        throw systemGroupRefusal
      }

      // -> Removing the guest account from the guests group would strip anonymous visitors of its
      //    permissions. `unassignUserFromGroup` refuses that pair too; this answers a conflict.
      const user = await CARDINAL.models.users.getById(req.params.userId)
      if (user?.isSystem) {
        return reply.conflict('Cannot unassign a system user from a group.')
      }

      // -> Emptying the root administrators group would lock everyone out of system management
      if (group.id === CARDINAL.config.auth.rootAdminGroupId) {
        if ((await CARDINAL.models.groups.countUsersInGroup(group.id)) <= 1) {
          return reply.conflict('Cannot remove the last user from the root administrators group.')
        }
      }

      await CARDINAL.models.groups.unassignUserFromGroup(group.id, req.params.userId)
      // -> As on assignment: `session.groups` is a login-time snapshot.
      await CARDINAL.models.sessions.clearSessionsFromUser(req.params.userId)
      await CARDINAL.models.auditLog.record({
        event: 'group.memberRemoved',
        actor: actorFromRequest(req),
        targetType: 'group',
        targetId: group.id,
        targetLabel: group.name,
        detail: { userId: user?.id ?? req.params.userId, userEmail: user?.email ?? '' }
      })
      return reply.code(204).send()
    }
  )
}

export default routes
