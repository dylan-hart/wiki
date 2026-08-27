import type { FastifyInstance } from 'fastify'
import { GLOBAL_PERMISSIONS, PAGE_PERMISSIONS } from '../../helpers/permissions.ts'
import { SITE_PERMISSIONS } from '../../helpers/siteRules.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * GLOBAL PERMISSION - The closed vocabulary a group's top-level `permissions` array may name.
   * Kept separate from `ApiKeyScopePermission#` (`api/schemas/apiKey.ts`), which additionally allows
   * page permissions -- an API key's scope narrows both kinds at once, but a group's `permissions`
   * field is global-only (page access is granted through `rules` instead).
   */
  app.addSchema({
    $id: 'GlobalPermission',
    type: 'string',
    enum: GLOBAL_PERMISSIONS
  })

  /**
   * GROUP RULE - A single page rule within a group
   */
  app.addSchema({
    $id: 'GroupRule',
    type: 'object',
    required: ['id', 'name', 'roles', 'match', 'mode', 'path'],
    properties: {
      id: {
        type: 'string',
        description: 'Client-generated identifier, unique within the group.'
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255
      },
      roles: {
        type: 'array',
        description: 'Permissions granted or denied by this rule.',
        items: {
          type: 'string',
          // -> `GroupRule.roles` is one shared vocabulary space across both kinds it may name -- see
          //    docs/decisions/delegated-per-site-administration.md.
          enum: [...PAGE_PERMISSIONS, ...SITE_PERMISSIONS]
        }
      },
      match: {
        type: 'string',
        description: 'How `path` is compared against the page path.',
        enum: ['START', 'END', 'REGEX', 'TAG', 'TAGALL', 'EXACT']
      },
      mode: {
        type: 'string',
        description:
          'ALLOW grants the roles, DENY revokes them, FORCEALLOW grants them and cannot be overridden by a later DENY.',
        enum: ['ALLOW', 'DENY', 'FORCEALLOW']
      },
      path: {
        type: 'string',
        maxLength: 255
      },
      locales: {
        type: 'array',
        description: 'Locale codes this rule is limited to. Empty means all locales.',
        items: {
          type: 'string'
        }
      },
      sites: {
        type: 'array',
        description: 'Site IDs this rule is limited to. Empty means all sites.',
        items: {
          type: 'string',
          format: 'uuid'
        }
      }
    }
  })

  /**
   * GROUP CORE - Essential fields only
   */
  app.addSchema({
    $id: 'GroupCore',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255
      },
      isSystem: {
        type: 'boolean',
        description: 'System groups cannot be deleted.'
      },
      userCount: {
        type: 'number',
        description: 'Number of users assigned to this group.'
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      }
    }
  })

  /**
   * GROUP - All fields
   */
  app.addSchema({
    $id: 'Group',
    allOf: [
      {
        $ref: 'GroupCore#'
      },
      {
        type: 'object',
        properties: {
          permissions: {
            type: 'array',
            description: 'Global permissions granted to members of this group.',
            items: {
              type: 'string'
            }
          },
          rules: {
            type: 'array',
            items: {
              $ref: 'GroupRule#'
            }
          },
          redirectOnLogin: {
            type: 'string'
          },
          redirectOnFirstLogin: {
            type: 'string'
          },
          redirectOnLogout: {
            type: 'string'
          }
        }
      }
    ]
  })
}
